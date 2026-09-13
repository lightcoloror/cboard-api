'use strict';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('user phone login controller', function() {
  let controller;
  let user;
  let lookupError;
  let verificationError;
  let consumed;

  beforeEach(function() {
    lookupError = null;
    verificationError = null;
    consumed = null;
    user = {
      _id: 'user-id',
      email: 'care@example.test',
      role: 'user',
      birthdate: new Date('1980-01-02T00:00:00.000Z'),
      location: { country: 'CN' },
      toJSON() {
        return {
          id: 'user-id',
          email: this.email,
          phoneMasked: '138****8000',
          boards: []
        };
      }
    };

    const User = {
      findOne(query) {
        const chain = {
          populate() {
            return chain;
          },
          async exec() {
            if (lookupError) throw lookupError;
            return query.phone === '13800138000' ? user : null;
          }
        };
        return chain;
      }
    };

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('../models/User', User);
    mockery.registerMock('../helpers/deviceSessions', { create: async () => 'a'.repeat(48) });
    mockery.registerMock('../models/ResetPassword', {});
    mockery.registerMock('../models/Settings', {
      async getOrCreate() {
        return { user: 'user-id', communicationSupport: {} };
      }
    });
    mockery.registerMock('../models/Subscribers', {
      async getByUserId() {
        return null;
      }
    });
    mockery.registerMock('../mail', { nev: { options: {} } });
    mockery.registerMock('../helpers/auth', {
      issueToken(value) {
        return `token:${value.id}:${value.email}`;
      }
    });
    mockery.registerMock('../helpers/phoneVerificationRuntime', {
      phoneVerificationService: {
        async consumeLoginVerification(value) {
          consumed = value;
          if (verificationError) throw verificationError;
          return { verified: true };
        }
      }
    });
    mockery.registerMock('../helpers/localize', {
      async findIpLocation() {
        return null;
      },
      isLocalIp() {
        return true;
      }
    });
    controller = require('../../api/controllers/user');
  });

  afterEach(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  function response() {
    return {
      statusCode: 0,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      }
    };
  }

  function request(phone = '13800138000', token = 'a'.repeat(64)) {
    return {
      get: () => 'test-device',
      body: { phone, phoneVerificationToken: token },
      session: {},
      ip: '127.0.0.1'
    };
  }

  it('consumes a login-purpose token and returns the existing CBoard session', async function() {
    const req = request();
    const res = response();

    await controller.loginUserWithPhone(req, res);

    expect(consumed).to.deep.equal({
      phone: '13800138000',
      token: 'a'.repeat(64)
    });
    expect(req.session.userId).to.equal('user-id');
    expect(res.statusCode).to.equal(200);
    expect(res.body).to.include({
      id: 'user-id',
      email: 'care@example.test',
      phoneMasked: '138****8000',
      authToken: 'token:user-id:care@example.test'
    });
    expect(res.body).not.to.have.property('phone');
  });

  it('returns one bounded failure for invalid, unverified, and unknown phones', async function() {
    const invalidResponse = response();
    await controller.loginUserWithPhone(
      request('not-a-phone'),
      invalidResponse
    );
    expect(invalidResponse.statusCode).to.equal(401);

    verificationError = Object.assign(new Error('private detail'), {
      status: 403,
      code: 'PHONE_VERIFICATION_REQUIRED'
    });
    const unverifiedResponse = response();
    await controller.loginUserWithPhone(request(), unverifiedResponse);
    expect(unverifiedResponse.statusCode).to.equal(401);

    verificationError = null;
    const unknownResponse = response();
    await controller.loginUserWithPhone(
      request('13900139000'),
      unknownResponse
    );
    expect(unknownResponse.statusCode).to.equal(401);

    [invalidResponse, unverifiedResponse, unknownResponse].forEach(res => {
      expect(res.body).to.deep.equal({
        message: 'Unable to sign in with this phone number.',
        error: { code: 'PHONE_LOGIN_FAILED' }
      });
    });
  });

  it('keeps administrator accounts on the stronger existing login paths', async function() {
    user.role = 'admin';
    const res = response();

    await controller.loginUserWithPhone(request(), res);

    expect(res.statusCode).to.equal(401);
    expect(res.body).to.deep.equal({
      message: 'Unable to sign in with this phone number.',
      error: { code: 'PHONE_LOGIN_FAILED' }
    });
  });

  it('fails closed when verification or user storage is unavailable', async function() {
    verificationError = Object.assign(new Error('provider secret'), {
      status: 503,
      code: 'PHONE_VERIFICATION_UNAVAILABLE'
    });
    const providerResponse = response();
    await controller.loginUserWithPhone(request(), providerResponse);
    expect(providerResponse.statusCode).to.equal(503);
    expect(providerResponse.body.message).not.to.contain('secret');

    verificationError = null;
    lookupError = new Error('mongo secret');
    const storageResponse = response();
    await controller.loginUserWithPhone(request(), storageResponse);
    expect(storageResponse.statusCode).to.equal(503);
    expect(storageResponse.body.message).not.to.contain('mongo');
  });
});

'use strict';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('registration privacy response', function() {
  let controller;
  let accountState;
  let phoneState;
  let senderError;
  let senderThrows;
  let createTempUserCalls;
  let sentVerificationCalls;
  let phoneLookupCalls;
  let consumedPhoneVerification;

  beforeEach(function() {
    accountState = 'new';
    phoneState = null;
    senderError = null;
    senderThrows = false;
    createTempUserCalls = 0;
    sentVerificationCalls = [];
    phoneLookupCalls = 0;
    consumedPhoneVerification = null;

    function User(data) {
      Object.assign(this, data);
    }
    User.findOne = function(query) {
      phoneLookupCalls += 1;
      const found = phoneState === 'persistent' && query.phone
        ? { email: 'persistent@example.test' }
        : null;
      return { exec: async function() { return found; } };
    };

    const TempUser = {
      findOne: function(query) {
        phoneLookupCalls += 1;
        const found = phoneState === 'temporary' && query.phone
          ? { email: 'temporary@example.test' }
          : null;
        return { exec: async function() { return found; } };
      }
    };
    const nev = {
      options: { tempUserModel: TempUser, URLFieldName: 'VERIFY_URL' },
      createTempUser: function(user, callback) {
        createTempUserCalls += 1;
        if (accountState === 'persistent') {
          return callback(null, { email: user.email }, null);
        }
        if (accountState === 'pending') return callback(null, null, null);
        if (accountState === 'duplicate-phone') {
          return callback(
            { code: 11000, keyPattern: { phone: 1 } },
            null,
            null
          );
        }
        return callback(null, null, { email: user.email, VERIFY_URL: 'url' });
      },
      sendVerificationEmail: function(email, domain, url, callback) {
        sentVerificationCalls.push({ email, domain, url });
        if (senderThrows) throw new Error('smtp provider secret');
        callback(senderError, { provider: 'private-provider-detail' });
      }
    };

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('../models/User', User);
    mockery.registerMock('../models/ResetPassword', {});
    mockery.registerMock('../models/Settings', {});
    mockery.registerMock('../models/Subscribers', {});
    mockery.registerMock('../mail', { nev });
    mockery.registerMock('../helpers/auth', {});
    mockery.registerMock('../helpers/careAccountDeletion', {});
    mockery.registerMock('../helpers/phoneVerificationRuntime', {
      phoneVerificationService: {
        async consumeRegistrationVerification(value) {
          consumedPhoneVerification = value;
          return { required: false, verified: false };
        }
      }
    });
    mockery.registerMock('../helpers/authRequestRateLimit', {
      getAuthRequestLimiters() { return {}; },
      async consumeAuthRequestLimits() {}
    });
    mockery.registerMock('../helpers/emailVerificationResendRateLimit', {
      emailVerificationResendRateLimit: { limiters: {} }
    });
    mockery.registerMock('../helpers/localize', {
      async findIpLocation() { return null; },
      isLocalIp() { return true; }
    });
    mockery.registerMock('../../config', {
      CBOARD_APP_URL: 'http://localhost:3000',
      emailTransport: {
        from: 'No Reply <noreply@example.test>',
        host: 'smtp.example.test',
        auth: { user: 'apikey', pass: 'configured-test-secret' }
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
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
  }

  function request(phone) {
    const body = {
      name: 'Caregiver',
      email: 'care@example.test',
      password: 'secret'
    };
    if (phone) body.phone = phone;
    return { body, ip: '127.0.0.1' };
  }

  it('uses one accepted response for confirmed, pending, and new email states', async function() {
    const bodies = [];
    for (const state of ['persistent', 'pending', 'new']) {
      accountState = state;
      const res = response();
      await controller.createUser(request(), res);
      expect(res.statusCode).to.equal(200);
      bodies.push(res.body);
    }

    expect(bodies[0]).to.deep.equal(bodies[1]);
    expect(bodies[1]).to.deep.equal(bodies[2]);
    expect(bodies[0]).to.deep.equal({
      success: 1,
      message:
        'If registration can proceed, please check your email for next steps.'
    });
    expect(sentVerificationCalls).to.have.length(1);
  });

  it('uses the same accepted response for duplicate phones even when verification is optional', async function() {
    phoneState = 'persistent';
    const persistent = response();
    await controller.createUser(request('13800138000'), persistent);

    phoneState = 'temporary';
    const temporary = response();
    await controller.createUser(request('13800138000'), temporary);

    expect(persistent.statusCode).to.equal(200);
    expect(temporary.statusCode).to.equal(200);
    expect(persistent.body).to.deep.equal({
      success: 1,
      message:
        'If registration can proceed, please check your email for next steps.'
    });
    expect(temporary.body).to.deep.equal(persistent.body);
    expect(consumedPhoneVerification).to.deep.equal({
      phone: '13800138000',
      token: undefined
    });
    expect(createTempUserCalls).to.equal(0);
    expect(sentVerificationCalls).to.deep.equal([]);
  });

  it('maps a raced duplicate phone to the same accepted response', async function() {
    accountState = 'duplicate-phone';
    const res = response();
    await controller.createUser(request('13800138000'), res);

    expect(res.statusCode).to.equal(200);
    expect(res.body.success).to.equal(1);
    expect(res.body.message).to.equal(
      'If registration can proceed, please check your email for next steps.'
    );
    expect(sentVerificationCalls).to.deep.equal([]);
  });

  it('keeps sender errors and synchronous sender throws opaque', async function() {
    senderError = new Error('provider secret');
    let res = response();
    await controller.createUser(request(), res);
    expect(res.statusCode).to.equal(200);
    expect(res.body).to.deep.equal({
      success: 1,
      message:
        'If registration can proceed, please check your email for next steps.'
    });
    expect(JSON.stringify(res.body)).not.to.contain('provider');

    senderError = null;
    senderThrows = true;
    res = response();
    await controller.createUser(request(), res);
    expect(res.statusCode).to.equal(200);
    expect(res.body.success).to.equal(1);
    expect(JSON.stringify(res.body)).not.to.contain('secret');
  });
});

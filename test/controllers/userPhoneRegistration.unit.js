const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('user phone registration controller', function() {
  let controller;
  let capturedUser;
  let createTempUserError;
  let phoneLookupCount;
  let sentVerification;
  let consumedPhoneVerification;
  let phoneVerificationError;

  beforeEach(function() {
    capturedUser = null;
    createTempUserError = null;
    phoneLookupCount = 0;
    sentVerification = null;
    consumedPhoneVerification = null;
    phoneVerificationError = null;

    function User(data) {
      capturedUser = { ...data };
      Object.assign(this, data);
    }
    User.findOne = function() {
      phoneLookupCount += 1;
      return {
        exec: async function() {
          return null;
        }
      };
    };

    const TempUser = {
      findOne: function() {
        phoneLookupCount += 1;
        return {
          exec: async function() {
            return null;
          }
        };
      }
    };
    const nev = {
      options: {
        tempUserModel: TempUser,
        URLFieldName: 'GENERATED_VERIFYING_URL'
      },
      createTempUser: function(user, callback) {
        if (createTempUserError) {
          callback(createTempUserError, null, null);
          return;
        }
        callback(null, null, {
          ...user,
          GENERATED_VERIFYING_URL: 'verification-url'
        });
      },
      sendVerificationEmail: function(email, domain, url, callback) {
        sentVerification = { email, domain, url };
        callback(null, {});
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
    mockery.registerMock('../helpers/phoneVerificationRuntime', {
      phoneVerificationService: {
        consumeRegistrationVerification: async function(value) {
          consumedPhoneVerification = value;
          if (phoneVerificationError) throw phoneVerificationError;
          return { required: false, verified: false };
        }
      }
    });
    mockery.registerMock('../helpers/localize', {
      findIpLocation: async function() {
        return null;
      },
      isLocalIp: function() {
        return true;
      }
    });
    controller = require('../../api/controllers/user');
  });

  afterEach(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  function createResponse() {
    return {
      statusCode: null,
      body: null,
      status: function(code) {
        this.statusCode = code;
        return this;
      },
      json: function(body) {
        this.body = body;
        return this;
      }
    };
  }

  function createRequest(phone, phoneVerificationToken) {
    const body = {
      name: 'Caregiver',
      email: 'care@example.test',
      password: 'secret'
    };
    if (phone !== undefined) body.phone = phone;
    if (phoneVerificationToken !== undefined) {
      body.phoneVerificationToken = phoneVerificationToken;
    }
    return {
      body,
      headers: { origin: 'http://localhost:3000' },
      ip: '127.0.0.1'
    };
  }

  it('rejects an invalid phone before creating a temporary user', async function() {
    const response = createResponse();

    await controller.createUser(createRequest('2800138000'), response);

    expect(response.statusCode).to.equal(400);
    expect(response.body.message).to.contain('11-digit');
    expect(capturedUser).to.equal(null);
    expect(phoneLookupCount).to.equal(0);
  });

  it('normalizes a valid phone and preserves the existing email activation flow', async function() {
    const response = createResponse();

    await controller.createUser(createRequest('138 0013 8000'), response);

    expect(response.statusCode).to.equal(200);
    expect(capturedUser.phone).to.equal('13800138000');
    expect(phoneLookupCount).to.equal(2);
    expect(consumedPhoneVerification).to.deep.equal({
      phone: '13800138000',
      token: undefined
    });
    expect(sentVerification).to.deep.equal({
      email: 'care@example.test',
      domain: 'http://localhost:3000',
      url: 'verification-url'
    });
  });

  it('keeps registrations without phone compatible with upstream CBoard', async function() {
    const response = createResponse();

    await controller.createUser(createRequest(undefined), response);

    expect(response.statusCode).to.equal(200);
    expect(capturedUser).not.to.have.property('phone');
    expect(capturedUser).not.to.have.property('phoneVerificationToken');
    expect(phoneLookupCount).to.equal(0);
    expect(consumedPhoneVerification).to.equal(null);
  });

  it('consumes a verified phone token without persisting it on the user', async function() {
    const response = createResponse();
    const token = 'a'.repeat(64);

    await controller.createUser(createRequest('13800138000', token), response);

    expect(response.statusCode).to.equal(200);
    expect(consumedPhoneVerification).to.deep.equal({
      phone: '13800138000',
      token
    });
    expect(capturedUser).not.to.have.property('phoneVerificationToken');
  });

  it('fails closed when required phone verification is missing', async function() {
    phoneVerificationError = Object.assign(
      new Error('Verify this phone number before registering.'),
      {
        status: 403,
        code: 'PHONE_VERIFICATION_REQUIRED'
      }
    );
    const response = createResponse();

    await controller.createUser(createRequest('13800138000'), response);

    expect(response.statusCode).to.equal(403);
    expect(response.body).to.deep.equal({
      message: 'Verify this phone number before registering.',
      error: { code: 'PHONE_VERIFICATION_REQUIRED' }
    });
    expect(capturedUser).to.equal(null);
    expect(sentVerification).to.equal(null);
  });

  it('maps a concurrent phone duplicate to a bounded conflict response', async function() {
    createTempUserError = Object.assign(new Error('duplicate phone value'), {
      code: 11000,
      keyPattern: { phone: 1 }
    });
    const response = createResponse();

    await controller.createUser(createRequest('13800138000'), response);

    expect(response.statusCode).to.equal(409);
    expect(response.body).to.deep.equal({
      message: 'This phone number is already registered.'
    });
    expect(sentVerification).to.equal(null);
  });

  it('does not expose a temporary-user storage failure', async function() {
    createTempUserError = new Error('mongo connection secret');
    const response = createResponse();

    await controller.createUser(createRequest('13800138000'), response);

    expect(response.statusCode).to.equal(500);
    expect(response.body).to.deep.equal({
      message: 'Unable to create the account.'
    });
    expect(response.body.message).not.to.contain('mongo');
  });
});

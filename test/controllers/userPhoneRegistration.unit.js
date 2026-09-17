const chai = require('chai');
const mockery = require('mockery');
const path = require('path');
const YAML = require('yamljs');
const ZSchema = require('z-schema');

const expect = chai.expect;

describe('user phone registration controller', function() {
  let controller;
  let capturedUser;
  let createTempUserError;
  let phoneLookupCount;
  let sentVerification;
  let consumedPhoneVerification;
  let phoneVerificationError;
  let createTempUserCalls;
  let verificationMailError;
  let emailTransportConfigured;
  let emailLinkConfigured;
  let registrationRateLimitError;

  beforeEach(function() {
    capturedUser = null;
    createTempUserError = null;
    phoneLookupCount = 0;
    sentVerification = null;
    consumedPhoneVerification = null;
    phoneVerificationError = null;
    createTempUserCalls = 0;
    verificationMailError = null;
    emailTransportConfigured = true;
    emailLinkConfigured = true;
    registrationRateLimitError = null;

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
        createTempUserCalls += 1;
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
        callback(verificationMailError, {});
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
    mockery.registerMock('../helpers/authRequestRateLimit', {
      getAuthRequestLimiters() { return {}; },
      async consumeAuthRequestLimits(input) {
        if (registrationRateLimitError) throw registrationRateLimitError;
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
    mockery.registerMock('../../config', {
      CBOARD_PROD_URL: 'https://app.example.test',
      CBOARD_QA_URL: 'https://qa.example.test',
      LOCALHOST_PORT_3000_URL: 'http://localhost:3000',
      get CBOARD_APP_URL() {
        return emailLinkConfigured ? 'http://localhost:3000' : '';
      },
      emailTransport: {
        from: 'No Reply <noreply@example.test>',
        host: 'smtp.example.test',
        auth: {
          user: 'apikey',
          get pass() {
            return emailTransportConfigured ? 'configured-test-secret' : '';
          }
        }
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
      set: function() {
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
      headers: { origin: 'https://attacker.example.test' },
      ip: '127.0.0.1'
    };
  }

  it('keeps TempUserResponse aligned with the POST /user response contract', function() {
    const spec = YAML.load(path.resolve(__dirname, '../../api/swagger/swagger.yaml'));
    const schema = spec.definitions.TempUserResponse;
    const validator = new ZSchema();

    expect(schema.properties).not.to.have.property('url');
    expect(schema.required).to.deep.equal(['success', 'message']);
    expect(validator.validate({ success: 1, message: 'ok' }, schema)).to.equal(true);
    expect(validator.validate({ success: 1 }, schema)).to.equal(false);
  });

  it('rejects an invalid phone before creating a temporary user', async function() {
    const response = createResponse();

    await controller.createUser(createRequest('2800138000'), response);

    expect(response.statusCode).to.equal(400);
    expect(response.body.message).to.contain('11-digit');
    expect(capturedUser).to.equal(null);
    expect(phoneLookupCount).to.equal(0);
  });

  it('fails closed before phone checks or temporary-user writes when email is unconfigured', async function() {
    emailTransportConfigured = false;
    const response = createResponse();

    await controller.createUser(createRequest('13800138000'), response);

    expect(response.statusCode).to.equal(503);
    expect(response.body).to.deep.equal({
      message: 'Email service is unavailable.',
      error: { code: 'MAIL_SERVICE_UNAVAILABLE' }
    });
    expect(createTempUserCalls).to.equal(0);
    expect(capturedUser).to.equal(null);
    expect(phoneLookupCount).to.equal(0);
    expect(consumedPhoneVerification).to.equal(null);
    expect(sentVerification).to.equal(null);
  });

  it('fails closed before phone checks or temporary-user writes when the email origin is invalid', async function() {
    emailLinkConfigured = false;
    const response = createResponse();

    await controller.createUser(createRequest('13800138000'), response);

    expect(response.statusCode).to.equal(503);
    expect(response.body.error.code).to.equal('MAIL_LINK_CONFIG_UNAVAILABLE');
    expect(createTempUserCalls).to.equal(0);
    expect(phoneLookupCount).to.equal(0);
  });

  it('returns a stable 429 before phone lookup when registration is limited', async function() {
    registrationRateLimitError = Object.assign(new Error('limited'), {
      status: 429,
      code: 'USER_REGISTRATION_RATE_LIMITED',
      retryAfter: 17
    });
    const response = createResponse();
    await controller.createUser(createRequest('13800138000'), response);
    expect(response.statusCode).to.equal(429);
    expect(response.body.message).to.equal('Too many authentication requests.');
    expect(response.body.error.code).to.equal('USER_REGISTRATION_RATE_LIMITED');
    expect(phoneLookupCount).to.equal(0);
    expect(createTempUserCalls).to.equal(0);
    const schema = YAML.load(path.resolve(__dirname, '../../api/swagger/swagger.yaml')).definitions.ErrorResponse;
    expect(new ZSchema().validate(response.body, schema)).to.equal(true);
  });

  it('fails closed with a stable 503 when registration limiter storage is unavailable', async function() {
    registrationRateLimitError = Object.assign(new Error('backend down'), {
      status: 503,
      code: 'USER_REGISTRATION_RATE_LIMIT_UNAVAILABLE'
    });
    const response = createResponse();
    await controller.createUser(createRequest('13800138000'), response);
    expect(response.statusCode).to.equal(503);
    expect(response.body.message).to.equal(
      'Authentication requests are temporarily unavailable.'
    );
    expect(response.body.error.code).to.equal(
      'USER_REGISTRATION_RATE_LIMIT_UNAVAILABLE'
    );
    expect(phoneLookupCount).to.equal(0);
    expect(createTempUserCalls).to.equal(0);
    const schema = YAML.load(path.resolve(__dirname, '../../api/swagger/swagger.yaml')).definitions.ErrorResponse;
    expect(new ZSchema().validate(response.body, schema)).to.equal(true);
  });

  it('normalizes a valid phone, sends verification email, and keeps its token out of the response', async function() {
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
    expect(response.body).to.deep.equal({
      success: 1,
      message:
        'If registration can proceed, please check your email for next steps.'
    });
    expect(response.body).not.to.have.property('url');
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

  it('constructs local registrations from an allowlist and ignores caller-controlled identity fields', async function() {
    const request = createRequest(undefined);
    Object.assign(request.body, {
      email: '  REGISTERED@Example.COM  ',
      name: 'Allowed Name',
      password: 'allowed-password',
      role: 'admin',
      provider: 'google',
      authVersion: 77,
      isFirstLogin: false,
      _id: '507f1f77bcf86cd799439011',
      google: { id: 'oauth-id', token: 'oauth-token' },
      facebook: { id: 'facebook-id', token: 'facebook-token' },
      apple: { id: 'apple-id', token: 'apple-token' },
      resetPasswordToken: 'reset-token',
      resetPasswordExpires: '2099-01-01',
      location: { city: 'caller-city' }
    });

    const response = createResponse();
    await controller.createUser(request, response);

    expect(response.statusCode).to.equal(200);
    expect(capturedUser).to.include({
      name: 'Allowed Name',
      email: 'registered@example.com',
      password: 'allowed-password',
      role: 'user',
      provider: '',
      authVersion: 0,
      isFirstLogin: true
    });
    expect(capturedUser).not.to.have.property('_id');
    expect(capturedUser).not.to.have.property('google');
    expect(capturedUser).not.to.have.property('facebook');
    expect(capturedUser).not.to.have.property('apple');
    expect(capturedUser).not.to.have.property('resetPasswordToken');
    expect(capturedUser).not.to.have.property('resetPasswordExpires');
    expect(capturedUser).not.to.have.property('location');
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
    expect(phoneLookupCount).to.equal(0);
    expect(sentVerification).to.equal(null);
  });

  it('maps a concurrent phone duplicate to the opaque accepted response', async function() {
    createTempUserError = Object.assign(new Error('duplicate phone value'), {
      code: 11000,
      keyPattern: { phone: 1 }
    });
    const response = createResponse();

    await controller.createUser(createRequest('13800138000'), response);

    expect(response.statusCode).to.equal(200);
    expect(response.body).to.deep.equal({
      success: 1,
      message:
        'If registration can proceed, please check your email for next steps.'
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

  it('keeps an available transport delivery failure opaque', async function() {
    verificationMailError = new Error('smtp delivery failed');
    const response = createResponse();

    await controller.createUser(createRequest('13800138000'), response);

    expect(response.statusCode).to.equal(200);
    expect(response.body).to.deep.equal({
      success: 1,
      message:
        'If registration can proceed, please check your email for next steps.'
    });
    expect(createTempUserCalls).to.equal(1);
    expect(sentVerification).not.to.equal(null);
  });
});

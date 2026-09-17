'use strict';

const bcrypt = require('bcryptjs');
const chai = require('chai');
const mockery = require('mockery');
const YAML = require('yamljs');
const ZSchema = require('z-schema');
const {
  compareResetToken,
  hashResetToken
} = require('../../api/helpers/passwordReset');

const expect = chai.expect;

describe('legacy email password reset controller security', function() {
  let controller;
  let emailUser;
  let resetRecord;
  let resetUpsert;
  let consumedReset;
  let userUpdate;
  let sentEmail;
  let emailTransportConfigured;
  let resetMailError;
  let userLookupCount;
  let passwordResetRateLimitError;
  let emailLinkConfigured;

  beforeEach(function() {
    emailUser = {
      _id: 'user-id',
      id: 'user-id',
      email: 'care@example.test',
      role: 'user'
    };
    resetRecord = null;
    resetUpsert = null;
    consumedReset = null;
    userUpdate = null;
    sentEmail = null;
    emailTransportConfigured = true;
    resetMailError = null;
    userLookupCount = 0;
    passwordResetRateLimitError = null;
    emailLinkConfigured = true;

    const User = {
      findOne(query) {
        userLookupCount += 1;
        return {
          async exec() {
            return query.email === 'care@example.test' ? emailUser : null;
          }
        };
      },
      findOneAndUpdate(filter, update, options) {
        userUpdate = { filter, update, options };
        return {
          async exec() {
            return filter._id === 'user-id' ? emailUser : null;
          }
        };
      }
    };

    const ResetPassword = {
      findOne(query) {
        return {
          async exec() {
            if (
              !resetRecord ||
              query.userId !== resetRecord.userId ||
              query.status !== false
            ) {
              return null;
            }
            return resetRecord.resetPasswordExpires > new Date()
              ? resetRecord
              : null;
          }
        };
      },
      findOneAndUpdate(filter, update, options) {
        if (options && options.upsert) {
          resetUpsert = { filter, update, options };
          return {
            async exec() {
              return { _id: 'reset-id' };
            }
          };
        }
        consumedReset = { filter, update, options };
        return {
          async exec() {
            return resetRecord && !resetRecord.consumed
              ? { ...resetRecord, status: true }
              : null;
          }
        };
      },
      updateMany() {
        return { async exec() {} };
      }
    };

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('../models/User', User);
    mockery.registerMock('../models/ResetPassword', ResetPassword);
    mockery.registerMock('../models/Settings', {});
    mockery.registerMock('../models/Subscribers', {});
    mockery.registerMock('../mail', {
      nev: {
        options: {},
        sendResetPasswordEmail(email, domain, userId, token, callback) {
          sentEmail = { email, domain, userId, token };
          callback(resetMailError);
        }
      }
    });
    mockery.registerMock('../helpers/auth', {});
    mockery.registerMock('../helpers/phoneVerificationRuntime', {
      phoneVerificationService: {}
    });
    mockery.registerMock('../helpers/authRequestRateLimit', {
      getAuthRequestLimiters() { return {}; },
      async consumeAuthRequestLimits() {
        if (passwordResetRateLimitError) throw passwordResetRateLimitError;
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

  function response() {
    return {
      statusCode: 0,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      set() {
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      }
    };
  }

  it('returns the same generic response and never exposes a raw reset token', async function() {
    const known = response();
    await controller.forgotPassword(
      {
        body: { email: 'care@example.test' },
        headers: { origin: 'http://localhost:3000' }
      },
      known
    );
    const unknown = response();
    await controller.forgotPassword(
      {
        body: { email: 'unknown@example.test' },
        headers: { origin: 'http://localhost:3000' }
      },
      unknown
    );

    expect(known.statusCode).to.equal(200);
    expect(unknown.statusCode).to.equal(200);
    expect(unknown.body).to.deep.equal(known.body);
    expect(known.body).to.deep.equal({
      success: 1,
      message:
        'If the account exists, password reset instructions will be sent shortly.'
    });
    expect(known.body).not.to.have.property('url');
    expect(known.body).not.to.have.property('userid');
    expect(sentEmail.token).to.match(/^[a-f0-9]{64}$/);
    expect(
      await compareResetToken(
        sentEmail.token,
        resetUpsert.update.$set.resetPasswordToken
      )
    ).to.equal(true);
  });

  it('does not pretend to send reset instructions when email is globally unconfigured', async function() {
    emailTransportConfigured = false;
    const res = response();

    await controller.forgotPassword(
      {
        body: { email: 'care@example.test' },
        headers: { origin: 'http://localhost:3000' }
      },
      res
    );

    expect(res.statusCode).to.equal(503);
    expect(res.body).to.deep.equal({
      message: 'Email service is unavailable.',
      error: { code: 'MAIL_SERVICE_UNAVAILABLE' }
    });
    expect(userLookupCount).to.equal(0);
    expect(resetUpsert).to.equal(null);
    expect(sentEmail).to.equal(null);
  });

  it('fails closed before the limiter or reset writes when the email origin is invalid', async function() {
    emailLinkConfigured = false;
    const res = response();
    await controller.forgotPassword(
      { body: { email: 'care@example.test' }, ip: '127.0.0.1', headers: {} },
      res
    );
    expect(res.statusCode).to.equal(503);
    expect(res.body.error.code).to.equal('MAIL_LINK_CONFIG_UNAVAILABLE');
    expect(userLookupCount).to.equal(0);
    expect(resetUpsert).to.equal(null);
    expect(sentEmail).to.equal(null);
  });

  it('returns the same 429 response for known and unknown emails before lookup', async function() {
    passwordResetRateLimitError = Object.assign(new Error('limited'), {
      status: 429,
      code: 'PASSWORD_RESET_RATE_LIMITED',
      retryAfter: 23
    });
    const known = response();
    await controller.forgotPassword(
      { body: { email: 'care@example.test' }, ip: '1.2.3.4' },
      known
    );
    const unknown = response();
    await controller.forgotPassword(
      { body: { email: 'unknown@example.test' }, ip: '1.2.3.4' },
      unknown
    );
    expect(known.statusCode).to.equal(429);
    expect(unknown.statusCode).to.equal(429);
    expect(known.body.message).to.equal('Too many authentication requests.');
    expect(known.body).to.deep.equal(unknown.body);
    expect(userLookupCount).to.equal(0);
    expect(resetUpsert).to.equal(null);
    expect(sentEmail).to.equal(null);
    const schema = YAML.load(require('path').resolve(__dirname, '../../api/swagger/swagger.yaml')).definitions.ErrorResponse;
    expect(new ZSchema().validate(known.body, schema)).to.equal(true);
  });

  it('fails closed with a stable 503 before lookup when reset limiter storage is unavailable', async function() {
    passwordResetRateLimitError = Object.assign(new Error('backend down'), {
      status: 503,
      code: 'PASSWORD_RESET_RATE_LIMIT_UNAVAILABLE'
    });
    const res = response();
    await controller.forgotPassword(
      { body: { email: 'care@example.test' }, ip: '1.2.3.4' },
      res
    );
    expect(res.statusCode).to.equal(503);
    expect(res.body.message).to.equal(
      'Authentication requests are temporarily unavailable.'
    );
    expect(res.body.error.code).to.equal(
      'PASSWORD_RESET_RATE_LIMIT_UNAVAILABLE'
    );
    expect(userLookupCount).to.equal(0);
    expect(resetUpsert).to.equal(null);
    expect(sentEmail).to.equal(null);
    const schema = YAML.load(require('path').resolve(__dirname, '../../api/swagger/swagger.yaml')).definitions.ErrorResponse;
    expect(new ZSchema().validate(res.body, schema)).to.equal(true);
  });

  it('keeps the configured transport response generic when delivery later fails', async function() {
    resetMailError = new Error('smtp delivery failed');
    const res = response();

    await controller.forgotPassword(
      {
        body: { email: 'care@example.test' },
        headers: { origin: 'http://localhost:3000' }
      },
      res
    );

    expect(res.statusCode).to.equal(200);
    expect(res.body).to.deep.equal({
      success: 1,
      message:
        'If the account exists, password reset instructions will be sent shortly.'
    });
    expect(resetUpsert).not.to.equal(null);
    expect(sentEmail).not.to.equal(null);
  });

  it('checks expiry and token before atomically consuming and updating the password', async function() {
    const token = 'd'.repeat(64);
    resetRecord = {
      _id: 'reset-id',
      userId: 'user-id',
      resetPasswordToken: await hashResetToken(token),
      resetPasswordExpires: new Date(Date.now() + 60000),
      status: false
    };
    const res = response();
    await controller.storePassword(
      {
        body: {
          userid: 'user-id',
          token,
          password: 'new-password'
        }
      },
      res
    );

    expect(res.statusCode).to.equal(200);
    expect(consumedReset.filter).to.include({
      _id: 'reset-id',
      status: false
    });
    expect(userUpdate.update.$inc).to.deep.equal({ authVersion: 1 });
    expect(
      await bcrypt.compare('new-password', userUpdate.update.$set.password)
    ).to.equal(true);
    expect(res.body).not.to.have.property('url');
  });

  it('rejects an invalid or expired token without changing the user', async function() {
    resetRecord = {
      _id: 'reset-id',
      userId: 'user-id',
      resetPasswordToken: await hashResetToken('e'.repeat(64)),
      resetPasswordExpires: new Date(Date.now() + 60000),
      status: false
    };
    const invalid = response();
    await controller.storePassword(
      {
        body: {
          userid: 'user-id',
          token: 'f'.repeat(64),
          password: 'new-password'
        }
      },
      invalid
    );

    expect(invalid.statusCode).to.equal(400);
    expect(userUpdate).to.equal(null);

    resetRecord.resetPasswordExpires = new Date(Date.now() - 1000);
    const expired = response();
    await controller.storePassword(
      {
        body: {
          userid: 'user-id',
          token: 'e'.repeat(64),
          password: 'new-password'
        }
      },
      expired
    );
    expect(expired.statusCode).to.equal(400);
    expect(userUpdate).to.equal(null);
  });
});

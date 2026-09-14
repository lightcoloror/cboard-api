'use strict';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('user verification resend controller', function() {
  let controller;
  let emailTransportConfigured;
  let limiterCalls;
  let limiterError;
  let nevCalls;
  let nevError;

  beforeEach(function() {
    emailTransportConfigured = true;
    limiterCalls = [];
    limiterError = null;
    nevCalls = [];
    nevError = null;
    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('../models/User', {});
    mockery.registerMock('../models/ResetPassword', {});
    mockery.registerMock('../models/Settings', {});
    mockery.registerMock('../models/Subscribers', {});
    mockery.registerMock('../mail', {
      nev: {
        resendVerificationEmail(email, domain, callback) {
          nevCalls.push({ email, domain });
          callback(nevError);
        }
      }
    });
    mockery.registerMock('../helpers/auth', {});
    mockery.registerMock('../helpers/phoneVerificationRuntime', {
      phoneVerificationService: {}
    });
    mockery.registerMock('../helpers/careAccountDeletion', {});
    mockery.registerMock('../helpers/localize', {
      async findIpLocation() {},
      isLocalIp() { return true; }
    });
    mockery.registerMock('../helpers/emailVerificationResendRateLimit', {
      emailVerificationResendRateLimit: { limiters: { fake: true } },
      async consumeEmailVerificationResendLimits(input) {
        limiterCalls.push(input);
        if (limiterError) throw limiterError;
      }
    });
    mockery.registerMock('../../config', {
      CBOARD_PROD_URL: 'https://app.example.test',
      CBOARD_QA_URL: 'https://qa.example.test',
      LOCALHOST_PORT_3000_URL: 'http://localhost:3000',
      emailTransport: {
        host: 'smtp.example.test',
        auth: {
          user: 'apikey',
          get pass() { return emailTransportConfigured ? 'test-secret' : ''; }
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
      headers: {},
      set(name, value) { this.headers[name] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
  }

  function request(email) {
    return {
      body: { email },
      headers: { origin: 'http://localhost:3000' },
      ip: '203.0.113.8'
    };
  }

  it('fails closed before limiter or NEV writes when email is unconfigured', async function() {
    emailTransportConfigured = false;
    const res = response();
    await controller.resendVerificationEmail(request('care@example.test'), res);
    expect(res.statusCode).to.equal(503);
    expect(res.body.error.code).to.equal('MAIL_SERVICE_UNAVAILABLE');
    expect(limiterCalls).to.deep.equal([]);
    expect(nevCalls).to.deep.equal([]);
  });

  it('accepts known, missing, and already-confirmed addresses with the same response', async function() {
    const known = response();
    await controller.resendVerificationEmail(request(' Care@Example.Test '), known);
    const missing = response();
    await controller.resendVerificationEmail(request('missing@example.test'), missing);

    expect(known.statusCode).to.equal(202);
    expect(missing.statusCode).to.equal(202);
    expect(known.body).to.deep.equal(missing.body);
    expect(nevCalls).to.deep.equal([
      { email: 'care@example.test', domain: 'http://localhost:3000' },
      { email: 'missing@example.test', domain: 'http://localhost:3000' }
    ]);
  });

  it('keeps a uniform accepted response when NEV delivery fails so a later retry remains possible', async function() {
    nevError = new Error('synthetic transport failure');
    const res = response();
    await controller.resendVerificationEmail(request('care@example.test'), res);
    expect(res.statusCode).to.equal(202);
    expect(res.body).to.deep.equal({
      success: 1,
      message:
        'Request accepted. If a pending account exists, check your email or try again later.'
    });
    expect(nevCalls).to.have.length(1);
  });

  it('returns an opaque retry-after response before NEV work when the atomic limiter rejects', async function() {
    limiterError = Object.assign(new Error('limited'), {
      status: 429,
      code: 'EMAIL_VERIFICATION_RATE_LIMITED',
      retryAfter: 60
    });
    const res = response();
    await controller.resendVerificationEmail(request('care@example.test'), res);
    expect(res.statusCode).to.equal(429);
    expect(res.headers['Retry-After']).to.equal('60');
    expect(res.body).to.deep.equal({
      error: {
        code: 'EMAIL_VERIFICATION_RATE_LIMITED',
        message: 'Too many verification requests.'
      }
    });
    expect(nevCalls).to.deep.equal([]);
  });
});

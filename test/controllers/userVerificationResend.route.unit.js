'use strict';

const bodyParser = require('body-parser');
const chai = require('chai');
const express = require('express');
const mockery = require('mockery');
const request = require('supertest');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');

const expect = chai.expect;

describe('user verification resend Swagger route', function() {
  let app;
  let emailTransportConfigured;
  let limiterError;
  let resendCalls;
  let limiterCalls;

  before(function(done) {
    emailTransportConfigured = true;
    limiterError = null;
    resendCalls = [];
    limiterCalls = [];
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
          resendCalls.push({ email, domain });
          callback(null, true);
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
      emailVerificationResendRateLimit: { limiters: { synthetic: true } },
      async consumeEmailVerificationResendLimits(input) {
        limiterCalls.push(input);
        if (limiterError) throw limiterError;
      }
    });
    mockery.registerMock('../../config', {
      CBOARD_PROD_URL: 'https://app.example.test',
      CBOARD_QA_URL: 'https://qa.example.test',
      LOCALHOST_PORT_3000_URL: 'http://localhost:3000',
      CBOARD_APP_URL: 'https://app.example.test',
      emailTransport: {
        host: 'smtp.example.test',
        auth: {
          user: 'apikey',
          get pass() { return emailTransportConfigured ? 'synthetic-secret' : ''; }
        }
      }
    });

    app = express();
    app.use(bodyParser.json());
    swaggerTools.initializeMiddleware(
      YAML.load('./api/swagger/swagger.yaml'),
      function initialize(middleware) {
        app.use(middleware.swaggerMetadata());
        app.use(middleware.swaggerValidator());
        app.use(
          middleware.swaggerRouter({
            controllers: './test/fixtures/userVerificationResendControllers',
            useStubs: false
          })
        );
        app.use(function handleError(error, req, res, next) {
          if (!error) return next();
          return res.status(error.status || 400).json({
            error: { message: error.message }
          });
        });
        done();
      }
    );
  });

  after(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  beforeEach(function() {
    emailTransportConfigured = true;
    limiterError = null;
    resendCalls = [];
    limiterCalls = [];
  });

  it('routes a valid request to the actual controller and returns 202', async function() {
    const response = await request(app)
      .post('/user/resend-verification')
      .send({ email: 'care@example.test' })
      .expect('Content-Type', /json/)
      .expect(202);

    expect(response.body).to.deep.equal({
      success: 1,
      message:
        'Request accepted. If a pending account exists, check your email or try again later.'
    });
    expect(limiterCalls).to.have.length(1);
    expect(resendCalls).to.deep.equal([
      { email: 'care@example.test', domain: 'https://app.example.test' }
    ]);
  });

  it('rejects a missing email through the Swagger request schema', async function() {
    await request(app)
      .post('/user/resend-verification')
      .send({})
      .expect('Content-Type', /json/)
      .expect(400);
    expect(limiterCalls).to.deep.equal([]);
    expect(resendCalls).to.deep.equal([]);
  });

  it('returns the real 503 body before limiter and mail work when unavailable', async function() {
    emailTransportConfigured = false;
    const response = await request(app)
      .post('/user/resend-verification')
      .send({ email: 'care@example.test' })
      .expect('Content-Type', /json/)
      .expect(503);

    expect(response.body).to.deep.equal({
      message: 'Email service is unavailable.',
      error: { code: 'MAIL_SERVICE_UNAVAILABLE' }
    });
    expect(limiterCalls).to.deep.equal([]);
    expect(resendCalls).to.deep.equal([]);
  });

  it('returns the real 429 response and Retry-After before mail work', async function() {
    limiterError = Object.assign(new Error('synthetic limited'), {
      status: 429,
      code: 'EMAIL_VERIFICATION_RATE_LIMITED',
      retryAfter: 60
    });
    const response = await request(app)
      .post('/user/resend-verification')
      .send({ email: 'care@example.test' })
      .expect('Content-Type', /json/)
      .expect(429);

    expect(response.headers['retry-after']).to.equal('60');
    expect(response.body).to.deep.equal({
      error: {
        code: 'EMAIL_VERIFICATION_RATE_LIMITED',
        message: 'Too many verification requests.'
      }
    });
    expect(resendCalls).to.deep.equal([]);
  });
});

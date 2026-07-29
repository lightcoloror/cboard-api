'use strict';

const bodyParser = require('body-parser');
const chai = require('chai');
const express = require('express');
const request = require('supertest');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');

const expect = chai.expect;

describe('Phone verification routes', function() {
  let app;

  before(function(done) {
    app = express();
    app.use(bodyParser.json());
    swaggerTools.initializeMiddleware(
      YAML.load('./api/swagger/swagger.yaml'),
      function initialize(middleware) {
        app.use(middleware.swaggerMetadata());
        app.use(middleware.swaggerValidator());
        app.use(
          middleware.swaggerRouter({
            controllers: './test/fixtures/phoneVerificationControllers',
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

  it('reports only bounded public capability fields', async function() {
    const response = await request(app)
      .get('/user/phone-verification')
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body).to.have.keys(
      'available',
      'phoneLoginAvailable',
      'phonePasswordResetAvailable',
      'requiredForPhoneRegistration',
      'challengeExpiresInSeconds',
      'verificationExpiresInSeconds',
      'resendAfterSeconds',
      'codeLength'
    );
    expect(response.body).not.to.have.property('secretId');
  });

  it('accepts a valid phone and rejects malformed challenge requests', async function() {
    await request(app)
      .post('/user/phone-verification')
      .send({ phone: '13800138000', purpose: 'login' })
      .expect(200);
    await request(app)
      .post('/user/phone-verification')
      .send({ phone: 'not-a-phone' })
      .expect(400);
    await request(app)
      .post('/user/phone-verification')
      .send({ phone: '13800138000', secret: 'not-allowed' })
      .expect(400);
    await request(app)
      .post('/user/phone-verification')
      .send({ phone: '13800138000', purpose: 'password-reset' })
      .expect(200);
    await request(app)
      .post('/user/phone-verification')
      .send({ phone: '13800138000', purpose: 'unknown' })
      .expect(400);
  });

  it('requires a bounded challenge, phone and six-digit code', async function() {
    await request(app)
      .post('/user/phone-verification/confirm')
      .send({
        challengeId: 'a'.repeat(64),
        phone: '13800138000',
        purpose: 'login',
        code: '123456'
      })
      .expect(200);
    await request(app)
      .post('/user/phone-verification/confirm')
      .send({
        challengeId: 'short',
        phone: '13800138000',
        code: '12345'
      })
      .expect(400);
  });

  it('accepts a purpose-bound phone login and rejects malformed tokens', async function() {
    await request(app)
      .post('/user/login/phone')
      .send({
        phone: '13800138000',
        phoneVerificationToken: 'b'.repeat(64)
      })
      .expect(200);
    await request(app)
      .post('/user/login/phone')
      .send({
        phone: '13800138000',
        phoneVerificationToken: 'short'
      })
      .expect(400);
  });

  it('accepts a purpose-bound phone password reset and rejects weak input', async function() {
    await request(app)
      .post('/user/store-password/phone')
      .send({
        phone: '13800138000',
        phoneVerificationToken: 'b'.repeat(64),
        password: 'new-password'
      })
      .expect(200);
    await request(app)
      .post('/user/store-password/phone')
      .send({
        phone: '13800138000',
        phoneVerificationToken: 'short',
        password: '123'
      })
      .expect(400);
  });
});

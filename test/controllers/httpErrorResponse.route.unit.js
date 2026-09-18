'use strict';

const assert = require('assert').strict;
const bodyParser = require('body-parser');
const express = require('express');
const request = require('supertest');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');
const { createHttpErrorHandler } = require('../../api/helpers/httpErrorResponse');

function securityError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

function createApp(done) {
  const app = express();
  app.use(bodyParser.json());

  swaggerTools.initializeMiddleware(YAML.load('./api/swagger/swagger.yaml'), middleware => {
    app.use(middleware.swaggerMetadata());
    app.use(middleware.swaggerSecurity({
      Bearer(req, _securityDefinition, token, cb) {
        const value = String(token || '');
        if (value.includes('forbidden')) return cb(securityError('private permission details', 403, 'USER_ACCESS_FORBIDDEN'));
        if (value.includes('storage')) return cb(securityError('private storage details', 503, 'SESSION_STORAGE_UNAVAILABLE'));
        return cb(securityError('private authentication details', 401, 'LOGIN_REQUIRED'));
      }
    }));
    app.use(middleware.swaggerRouter({
      controllers: './test/fixtures/careTrialControllers',
      useStubs: false
    }));
    app.get('/unknown', () => {
      throw new Error('private stack and database details');
    });
    app.get('/unknown-service', (req, res, next) => {
      next(Object.assign(new Error('private service details'), { statusCode: 503 }));
    });
    app.use(createHttpErrorHandler());
    done(app);
  });
}

describe('JSON HTTP error handler', function() {
  let app;

  before(function(done) {
    createApp(value => { app = value; done(); });
  });

  it('normalizes a real Swagger security failure to a cache-safe login JSON response', async function() {
    const response = await request(app)
      .get('/care/account/closure-preview')
      .expect('Content-Type', /json/)
      .expect(401);

    assert.deepEqual(response.body, { code: 'LOGIN_REQUIRED' });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.text.includes('private authentication details'), false);
  });

  it('preserves the established permission code from the real Swagger security chain', async function() {
    const response = await request(app)
      .get('/care/account/closure-preview')
      .set('Authorization', 'Bearer forbidden-token')
      .expect('Content-Type', /json/)
      .expect(403);

    assert.deepEqual(response.body, { code: 'USER_ACCESS_FORBIDDEN' });
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  it('preserves the explicit authentication storage code while hiding its details', async function() {
    const response = await request(app)
      .get('/care/account/closure-preview')
      .set('Authorization', 'Bearer storage-token')
      .expect('Content-Type', /json/)
      .expect(503);

    assert.deepEqual(response.body, { code: 'SESSION_STORAGE_UNAVAILABLE' });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.text.includes('private storage details'), false);
  });

  it('uses a generic service code for an unknown 503 and sanitizes unknown 500 failures', async function() {
    const unavailable = await request(app)
      .get('/unknown-service')
      .expect('Content-Type', /json/)
      .expect(503);
    assert.deepEqual(unavailable.body, { code: 'SERVICE_UNAVAILABLE' });
    assert.equal(unavailable.headers['cache-control'], 'no-store');

    const unknown = await request(app)
      .get('/unknown')
      .expect('Content-Type', /json/)
      .expect(500);
    assert.deepEqual(unknown.body, { code: 'INTERNAL_SERVER_ERROR' });
    assert.equal(unknown.headers['cache-control'], 'no-store');
    assert.equal(unknown.text.includes('private stack and database details'), false);
  });

  it('delegates to the next error handler after headers have been sent', async function() {
    const partial = express();
    partial.get('/partial', (req, res, next) => {
      res.write('partial');
      next(new Error('late failure'));
    });
    partial.use(createHttpErrorHandler());
    partial.use((error, req, res, next) => {
      assert.equal(error.message, 'late failure');
      res.end(' delegated');
    });

    const response = await request(partial).get('/partial').expect(200);
    assert.equal(response.text, 'partial delegated');
  });
});

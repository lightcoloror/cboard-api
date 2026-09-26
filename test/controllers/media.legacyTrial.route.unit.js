'use strict';

const assert = require('assert').strict;
const express = require('express');
const mockery = require('mockery');
const request = require('supertest');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');
const { createHttpErrorHandler } = require('../../api/helpers/httpErrorResponse');

describe('legacy public trial media HTTP route harness', function() {
  let app;
  let blobCalls;
  const previousTrialFlag = process.env.CARE_PUBLIC_TRIAL_ENABLED;

  before(function(done) {
    process.env.CARE_PUBLIC_TRIAL_ENABLED = 'true';
    blobCalls = [];
    mockery.enable({ warnOnReplace: false, warnOnUnregistered: false, useCleanCache: true });
    mockery.registerMock('../helpers/blob', {
      async createBlockBlobFromText(...args) {
        blobCalls.push(args);
        return [{ name: 'unexpected' }, 'https://blob.invalid/unexpected'];
      }
    });

    app = express();
    const mediaController = require('../../api/controllers/media');
    swaggerTools.initializeMiddleware(YAML.load('./api/swagger/swagger.yaml'), middleware => {
      app.use(middleware.swaggerMetadata());
      // The production bearer verifier is intentionally mocked here: it is
      // Mongo/session-backed. The route and media controller remain real.
      app.use((req, _res, next) => {
        if (req.get('Authorization') === 'Bearer synthetic') {
          req.user = { id: 'user-a', role: 'user' };
          return next();
        }
        const error = new Error('private authentication details');
        error.statusCode = 401;
        error.code = 'LOGIN_REQUIRED';
        return next(error);
      });
      app.use(middleware.swaggerValidator());
      // The production Swagger router loads every controller, including
      // database-backed modules. This harness keeps the real /media route and
      // media controller while isolating that unrelated application startup.
      app.post('/media', mediaController.uploadMedia);
      app.use(createHttpErrorHandler());
      done();
    });
  });

  after(function() {
    delete require.cache[require.resolve('../../api/controllers/media')];
    mockery.deregisterAll();
    mockery.disable();
    if (previousTrialFlag === undefined) delete process.env.CARE_PUBLIC_TRIAL_ENABLED;
    else process.env.CARE_PUBLIC_TRIAL_ENABLED = previousTrialFlag;
  });

  function mediaUpload() {
    return request(app)
      .post('/media')
      .attach('file', Buffer.from([1, 2, 3]), {
        filename: 'photo.png',
        contentType: 'image/png'
      });
  }

  it('runs Swagger metadata/validation with the real mounted controller and rejects authorized upload before blob access', async function() {
    const response = await mediaUpload()
      .set('Authorization', 'Bearer synthetic')
      .expect('Content-Type', /json/)
      .expect(403);

    assert.deepEqual(response.body, {
      code: 'LEGACY_MEDIA_UPLOAD_DISABLED',
      message: 'Legacy public media uploads are disabled; use patient profile private media.'
    });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(blobCalls, []);
  });

  it('keeps authentication first for an unauthenticated legacy upload', async function() {
    const response = await mediaUpload()
      .expect('Content-Type', /json/)
      .expect(401);

    assert.deepEqual(response.body, { code: 'LOGIN_REQUIRED' });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(blobCalls, []);
  });
});

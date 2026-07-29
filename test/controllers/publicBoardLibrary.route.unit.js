'use strict';

const express = require('express');
const request = require('supertest');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');

describe('Public board library route', function() {
  let app;

  before(function(done) {
    app = express();
    swaggerTools.initializeMiddleware(
      YAML.load('./api/swagger/swagger.yaml'),
      function initialize(middleware) {
        app.use(middleware.swaggerMetadata());
        app.use(middleware.swaggerValidator());
        app.use(
          middleware.swaggerRouter({
            controllers: './test/fixtures/publicBoardLibraryControllers',
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

  it('serves a public board bundle without authentication', async function() {
    await request(app)
      .get('/board/public/507f1f77bcf86cd799439011/bundle')
      .expect('Content-Type', /json/)
      .expect(200);
  });

  it('rejects malformed board ids at the Swagger boundary', async function() {
    await request(app)
      .get('/board/public/not-an-object-id/bundle')
      .expect(400);
  });

  it('serves a normalized public tile image without authentication', async function() {
    await request(app)
      .get('/board/public/507f1f77bcf86cd799439011/tile/water%20cup/image')
      .expect('Content-Type', /image\/png/)
      .expect(200);
  });

  it('rejects an empty public tile image id at the Swagger boundary', async function() {
    await request(app)
      .get('/board/public/507f1f77bcf86cd799439011/tile//image')
      .expect(404);
  });
});

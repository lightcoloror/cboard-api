'use strict';

const chai = require('chai');
const express = require('express');
const request = require('supertest');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');

const expect = chai.expect;

describe('Communication AAC import route', function() {
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
            controllers: './test/fixtures/communicationAacImportControllers',
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

  it('accepts a Snap file through the authenticated multipart contract', async function() {
    const buffer = Buffer.concat([
      Buffer.from('SQLite format 3\0', 'binary'),
      Buffer.from('fixture')
    ]);
    const response = await request(app)
      .post('/communication/aac-import/convert?format=snap&locale=zh-CN')
      .attach('file', buffer, {
        filename: 'patient.sps',
        contentType: 'application/octet-stream'
      })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body).to.include({
      format: 'picinterpreter-aac-conversion',
      contractVersion: 1,
      sourceFormat: 'snap',
      sourceFileName: 'patient.sps'
    });
  });

  it('rejects missing source format and missing file at the Swagger boundary', async function() {
    const buffer = Buffer.concat([
      Buffer.from('SQLite format 3\0', 'binary'),
      Buffer.from('fixture')
    ]);

    await request(app)
      .post('/communication/aac-import/convert')
      .attach('file', buffer, 'patient.sps')
      .expect(400);

    await request(app)
      .post('/communication/aac-import/convert?format=snap')
      .expect(400);
  });

  it('rejects unsupported formats and malformed locales before the controller', async function() {
    const buffer = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('fixture')
    ]);

    await request(app)
      .post('/communication/aac-import/convert?format=gridset')
      .attach('file', buffer, 'patient.ce')
      .expect(400);

    await request(app)
      .post('/communication/aac-import/convert?format=touchchat&locale=bad_locale')
      .attach('file', buffer, 'patient.ce')
      .expect(400);
  });
});

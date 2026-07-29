'use strict';

const chai = require('chai');
const express = require('express');
const request = require('supertest');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');

const expect = chai.expect;

describe('Private picture library routes', function() {
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
            controllers:
              './test/fixtures/communicationPrivateLibraryControllers',
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

  it('exposes metadata without a blob URL', async function() {
    const response = await request(app)
      .get('/communication/private-library')
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body.format).to.equal(
      'picinterpreter-private-picture-library-encrypted'
    );
    expect(response.body).not.to.have.property('url');
  });

  it('accepts the encrypted private picture archive through multipart', async function() {
    const buffer = Buffer.concat([
      Buffer.from('PIE2EE01', 'ascii'),
      Buffer.from('upload')
    ]);
    const response = await request(app)
      .post('/communication/private-library')
      .attach('file', buffer, {
        filename: 'private-picture-library.pijenc',
        contentType: 'application/octet-stream'
      })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body.size).to.equal(buffer.length);
  });

  it('downloads encrypted bytes and exposes deletion', async function() {
    const download = await request(app)
      .get('/communication/private-library/download')
      .buffer(true)
      .parse(function parseBinary(res, callback) {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect('Content-Type', /application\/octet-stream/)
      .expect(200);
    expect(download.body.subarray(0, 8)).to.deep.equal(
      Buffer.from('PIE2EE01', 'ascii')
    );

    const deleted = await request(app)
      .delete('/communication/private-library')
      .expect('Content-Type', /json/)
      .expect(200);
    expect(deleted.body).to.deep.equal({ deleted: true });
  });

  it('keeps complete device data in a separate authenticated archive contract', async function() {
    const metadata = await request(app)
      .get('/communication/private-device-data')
      .expect('Content-Type', /json/)
      .expect(200);
    expect(metadata.body.updatedAt).to.equal(400);
    expect(metadata.body.format).to.equal(
      'picinterpreter-private-device-data-encrypted'
    );
    expect(metadata.body.contractVersion).to.equal(2);

    const buffer = Buffer.concat([
      Buffer.from('PIE2EE01', 'ascii'),
      Buffer.from('device-data-upload')
    ]);
    const upload = await request(app)
      .post('/communication/private-device-data')
      .attach('file', buffer, {
        filename: 'private-device-data.pijenc',
        contentType: 'application/octet-stream'
      })
      .expect('Content-Type', /json/)
      .expect(200);
    expect(upload.body.size).to.equal(buffer.length);

    const download = await request(app)
      .get('/communication/private-device-data/download')
      .buffer(true)
      .parse(function parseBinary(res, callback) {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect('Content-Type', /application\/octet-stream/)
      .expect(200);
    expect(download.body.subarray(0, 8)).to.deep.equal(
      Buffer.from('PIE2EE01', 'ascii')
    );

    const deleted = await request(app)
      .delete('/communication/private-device-data')
      .expect('Content-Type', /json/)
      .expect(200);
    expect(deleted.body).to.deep.equal({ deleted: true });
  });
});

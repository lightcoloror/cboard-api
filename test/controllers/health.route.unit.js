'use strict';

const chai = require('chai');
const express = require('express');
const request = require('supertest');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');

const expect = chai.expect;

describe('Health route', function() {
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
            controllers: './test/fixtures/healthControllers',
            useStubs: false
          })
        );
        done();
      }
    );
  });

  it('is public and returns only bounded readiness fields', async function() {
    const response = await request(app)
      .get('/health')
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body).to.deep.equal({
      status: 'ok',
      database: 'connected',
      communicationIndexes: 'ready',
      privatePictureLibrary: 'configured'
    });
    expect(response.body).not.to.have.property('databaseUrl');
  });
});

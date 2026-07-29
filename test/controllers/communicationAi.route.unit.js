'use strict';

const bodyParser = require('body-parser');
const chai = require('chai');
const express = require('express');
const request = require('supertest');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');

const expect = chai.expect;

describe('Communication AI routes', function() {
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
            controllers: './test/fixtures/communicationAiControllers',
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

  it('reports the optional provider state without exposing an API key', async function() {
    const response = await request(app)
      .get('/gpt/communication/health')
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body).to.have.keys(
      'configured',
      'provider',
      'model',
      'baseUrl',
      'imageAiConfigured',
      'imageAiProvider',
      'imageAiModel',
      'dialectAsrConfigured',
      'dialectAsrProvider',
      'dialectAsrEngine',
      'backgroundRemovalConfigured',
      'backgroundRemovalProvider',
      'speechConfigured',
      'speechProvider',
      'speechModel',
      'speechVoice',
      'speechVoices',
      'enhancementRateLimitEnabled',
      'enhancementPointsPerMinute',
      'enhancementMonthlyPoints',
      'aiTokenQuotaEnabled',
      'aiMonthlyTokenQuota',
      'aiTextTokenReservation',
      'aiImageTokenReservation'
    );
    expect(response.body).not.to.have.property('apiKey');
  });

  it('rejects an empty pictogram-label request at the Swagger boundary', async function() {
    await request(app)
      .post('/gpt/communication/sentences')
      .send({ pictogramLabels: [] })
      .expect('Content-Type', /json/)
      .expect(400);
  });

  it('rejects oversized resegmentation text at the Swagger boundary', async function() {
    await request(app)
      .post('/gpt/communication/resegment')
      .send({ text: '字'.repeat(121) })
      .expect('Content-Type', /json/)
      .expect(400);
  });

  it('returns a content-free current-month usage summary', async function() {
    const response = await request(app)
      .get('/gpt/communication/usage')
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body).to.deep.equal({
      month: '2026-07',
      requestCount: 0,
      reportedRequestCount: 0,
      unreportedRequestCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      providerReported: false,
      breakdown: []
    });
  });

  it('rejects missing or oversized speech text at the Swagger boundary', async function() {
    await request(app)
      .post('/gpt/communication/speech')
      .send({})
      .expect('Content-Type', /json/)
      .expect(400);

    await request(app)
      .post('/gpt/communication/speech')
      .send({ text: '字'.repeat(301) })
      .expect('Content-Type', /json/)
      .expect(400);
  });

  it('rejects an oversized speech voice at the Swagger boundary', async function() {
    await request(app)
      .post('/gpt/communication/speech')
      .send({ text: '需要帮助。', voice: 'v'.repeat(81) })
      .expect('Content-Type', /json/)
      .expect(400);
  });

  it('rejects unsupported or oversized dialect normalization input at the Swagger boundary', async function() {
    await request(app)
      .post('/gpt/communication/dialect-normalization')
      .send({ text: '饮水', dialect: 'unknown' })
      .expect('Content-Type', /json/)
      .expect(400);

    await request(app)
      .post('/gpt/communication/dialect-normalization')
      .send({ text: '字'.repeat(121), dialect: 'cantonese' })
      .expect('Content-Type', /json/)
      .expect(400);
  });

  it('requires an OCR image at the Swagger boundary', async function() {
    await request(app)
      .post('/gpt/communication/ocr')
      .expect('Content-Type', /json/)
      .expect(400);
  });

  it('requires dialect audio at the Swagger boundary', async function() {
    await request(app)
      .post('/gpt/communication/dialect-asr')
      .expect('Content-Type', /json/)
      .expect(400);
  });

  it('requires a pictogram metadata image at the Swagger boundary', async function() {
    await request(app)
      .post('/gpt/communication/pictogram-metadata')
      .expect('Content-Type', /json/)
      .expect(400);
  });

  it('requires a bounded pictogram generation label at the Swagger boundary', async function() {
    await request(app)
      .post('/gpt/communication/pictogram-generation')
      .send({ label: '' })
      .expect('Content-Type', /json/)
      .expect(400);

    await request(app)
      .post('/gpt/communication/pictogram-generation')
      .send({ label: '字'.repeat(25) })
      .expect('Content-Type', /json/)
      .expect(400);
  });

  it('requires a background removal image at the Swagger boundary', async function() {
    await request(app)
      .post('/gpt/communication/background-removal')
      .expect('Content-Type', /json/)
      .expect(400);
  });
});

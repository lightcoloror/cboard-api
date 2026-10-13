'use strict';

const { expect } = require('chai');
const express = require('express');
const request = require('supertest');
const nock = require('nock');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');
const controller = require('../../api/controllers/gpt');
const usage = require('../../api/helpers/communicationAiUsage');

// Real Swagger/controller/SDK/helper, synthetic provider and in-memory usage.
// No real provider, credentials, patients or database are used by this suite.
describe('Source-preserving resegmentation HTTP contract', function() {
  let app;
  let starts;
  let events;
  const keys = ['AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL'];
  const saved = {};
  const originalUsage = usage.settleAndRecordCommunicationAiUsage;

  before(function(done) {
    keys.forEach(key => { saved[key] = process.env[key]; });
    process.env.AI_API_KEY = 'synthetic-resegmentation-test';
    process.env.AI_BASE_URL = 'https://resegmentation.example.invalid/v1';
    process.env.AI_MODEL = 'synthetic-model';
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
    usage.settleAndRecordCommunicationAiUsage = async value => { events.push(value.event); };
    app = express();
    app.use(express.json());
    swaggerTools.initializeMiddleware(YAML.load('./api/swagger/swagger.yaml'), middleware => {
      app.use(middleware.swaggerMetadata());
      app.use(middleware.swaggerValidator());
      app.post('/gpt/communication/resegment', (req, res) => {
        req.user = { id: 'synthetic-user' };
        req.careUsage = { markProviderStarted() { starts += 1; } };
        return controller.resegmentCommunicationText(req, res);
      });
      app.use((error, req, res, next) => {
        if (!error) return next();
        return res.status(error.status || 400).json({ error: { message: error.message } });
      });
      done();
    });
  });
  beforeEach(function() { starts = 0; events = []; });
  afterEach(function() { nock.cleanAll(); });
  after(function() {
    usage.settleAndRecordCommunicationAiUsage = originalUsage;
    keys.forEach(key => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
    nock.enableNetConnect();
  });

  function provider(tokens, finish = 'stop') {
    return nock('https://resegmentation.example.invalid')
      .post('/v1/chat/completions', body => body.messages.length === 2)
      .reply(200, {
        choices: [{ message: { content: JSON.stringify({ tokens }) }, finish_reason: finish }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
      });
  }

  it('returns private v2 ordered spans through the real endpoint', async function() {
    const upstream = provider(['别', '打针', '，', '喝水', '喝水', '🙂']);
    const response = await request(app).post('/gpt/communication/resegment')
      .send({ contractVersion: 2, text: '别打针，喝水喝水🙂', pictogramVocabulary: ['打针'] }).expect(200);
    expect(response.body.tokens.join('')).to.equal('别打针，喝水喝水🙂');
    expect(response.body.contractVersion).to.equal(2);
    expect(response.body.segments[5]).to.deep.equal({ start: 8, end: 9, surface: '🙂' });
    expect(response.body.requiresConfirmation).to.equal(true);
    expect(response.headers['cache-control']).to.include('no-store');
    expect(starts).to.equal(1);
    expect(events).to.have.length(1);
    expect(upstream.isDone()).to.equal(true);
  });

  it('rejects lost negation with a stable code while accounting for actual provider usage', async function() {
    provider(['打针']);
    const response = await request(app).post('/gpt/communication/resegment')
      .send({ text: '别打针' }).expect(502);
    expect(response.body.error.code).to.equal('AI_RESEGMENT_SOURCE_MISMATCH');
    expect(JSON.stringify(response.body)).not.to.include('别打针');
    expect(events).to.have.length(1);
  });

  it('rejects provider truncation even if the partial JSON happens to reconstruct the source', async function() {
    provider(['喝水'], 'length');
    await request(app).post('/gpt/communication/resegment').send({ text: '喝水' }).expect(502);
  });

  it('rejects blank text and future contracts before provider-start accounting', async function() {
    await request(app).post('/gpt/communication/resegment').send({ text: ' ' }).expect(400);
    await request(app).post('/gpt/communication/resegment').send({ text: '喝水', contractVersion: 99 }).expect(400);
    expect(starts).to.equal(0);
    expect(events).to.have.length(0);
  });

  it('accepts the documented 120-code-point Unicode boundary without slicing', async function() {
    const text = '🙂'.repeat(120);
    provider([text]);
    const response = await request(app).post('/gpt/communication/resegment').send({ text }).expect(200);
    expect(response.body.sourceText).to.equal(text);
    expect(response.body.segments[0].end).to.equal(120);
  });
});

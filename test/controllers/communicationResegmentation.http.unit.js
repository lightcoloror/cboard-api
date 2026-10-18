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
  const keys = ['AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'AI_RESEGMENT_REQUEST_OPTIONS'];
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
  beforeEach(function() { starts = 0; events = []; delete process.env.AI_RESEGMENT_REQUEST_OPTIONS; });
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

  it('sends fixed development examples separately from the current user text', async function() {
    const text = '请帮忙';
    let sent;
    const upstream = nock('https://resegmentation.example.invalid')
      .post('/v1/chat/completions', body => { sent = body; return true; })
      .reply(200, { choices: [{ message: { content: JSON.stringify({ tokens: [text] }) }, finish_reason: 'stop' }] });
    await request(app).post('/gpt/communication/resegment').send({ text }).expect(200);
    expect(upstream.isDone()).to.equal(true);
    expect(sent.messages[0].role).to.equal('system');
    expect(sent.messages[0].content).to.include('不是不想吃饭');
    expect(sent.messages[0].content).to.include('眼镜盒不是眼镜');
    expect(sent.messages[0].content).to.include('我今晚不回家吃饭');
    expect(JSON.parse(sent.messages[1].content).text).to.equal(text);
    expect(sent.messages).to.have.length(2);
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

  it('sends configured domestic-model options through the real SDK but ignores client overrides', async function() {
    process.env.AI_RESEGMENT_REQUEST_OPTIONS = JSON.stringify({
      enable_thinking: false, max_tokens: 2048, response_format: 'json_object'
    });
    let sent;
    const upstream = nock('https://resegmentation.example.invalid')
      .post('/v1/chat/completions', body => { sent = body; return true; })
      .reply(200, { choices: [{ message: { content: '{"tokens":["请帮忙"]}' }, finish_reason: 'stop' }] });
    await request(app).post('/gpt/communication/resegment').send({
      text: '请帮忙', model: 'untrusted-model', enable_thinking: true,
      resegmentRequestOptions: { max_tokens: 99999 }
    }).expect(200);
    expect(upstream.isDone()).to.equal(true);
    expect(sent).to.include({ model: 'synthetic-model', enable_thinking: false, max_tokens: 2048 });
    expect(sent.response_format).to.deep.equal({ type: 'json_object' });
    expect(sent).not.to.have.property('extra_body');
  });

  it('applies a config change on the next request and still rejects changed source text', async function() {
    process.env.AI_RESEGMENT_REQUEST_OPTIONS = '{"response_format":"json_schema"}';
    let sent;
    nock('https://resegmentation.example.invalid').post('/v1/chat/completions', body => {
      sent = body; return true;
    }).reply(200, { choices: [{ message: { content: '{"tokens":["打针"]}' }, finish_reason: 'stop' }] });
    const response = await request(app).post('/gpt/communication/resegment').send({ text: '别打针' }).expect(502);
    expect(sent.response_format.type).to.equal('json_schema');
    expect(response.body.error.code).to.equal('AI_RESEGMENT_SOURCE_MISMATCH');
  });

  it('rejects invalid server options before provider-start and without leaking configuration', async function() {
    process.env.AI_RESEGMENT_REQUEST_OPTIONS = '{"model":"secret-value"}';
    const response = await request(app).post('/gpt/communication/resegment').send({ text: '喝水' }).expect(503);
    expect(response.body.error.code).to.equal('AI_RESEGMENT_CONFIGURATION_INVALID');
    expect(JSON.stringify(response.body)).not.to.include('secret-value');
    expect(starts).to.equal(0);
  });

  it('does not silently repeat a failed paid provider call', async function() {
    let calls = 0;
    const upstream = nock('https://resegmentation.example.invalid')
      .post('/v1/chat/completions').reply(() => { calls += 1; return [500, { error: { message: 'synthetic failure' } }]; });
    await request(app).post('/gpt/communication/resegment').send({ text: '喝水' }).expect(500);
    expect(upstream.isDone()).to.equal(true);
    expect(calls).to.equal(1);
    expect(starts).to.equal(1);
    expect(events).to.have.length(0);
  });
});

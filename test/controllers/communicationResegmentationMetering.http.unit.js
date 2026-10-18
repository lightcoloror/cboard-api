'use strict';

const assert = require('assert').strict;
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const nock = require('nock');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');
const controller = require('../../api/controllers/gpt');
const usage = require('../../api/helpers/communicationAiUsage');
const { createCareAiMetering } = require('../../api/helpers/careAiMetering');
const { createCareBudget } = require('../../api/helpers/careBudget');
const { createCareCrypto } = require('../../api/helpers/careCrypto');
const { DAY } = require('../../api/helpers/carePolicy');

// Real Swagger, controller, SDK, usage normalizer, meter and encrypted budget.
// Auth and storage adapters are synthetic; this is not Mongo or live-provider
// acceptance. All external traffic is blocked and only loopback is allowed.
describe('Resegmentation HTTP family-budget settlement', function() {
  this.timeout(10000);
  let app;
  let budget;
  let budgetOptions;
  let settlements;
  let recorded;
  let denyProfile = false;
  let failCompletion = false;
  let completionWrites = 0;
  let docs;
  let clock;
  let afterCompletion;
  let failAfterCommit;
  const envKeys = ['AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'AI_REQUEST_TIMEOUT_MS', 'AI_RESEGMENT_REQUEST_OPTIONS', 'AI_SENTENCE_REQUEST_OPTIONS'];
  const saved = {};
  const origin = 'https://resegmentation-metering.example.invalid';
  const originalUsage = usage.settleAndRecordCommunicationAiUsage;
  const clone = value => value && JSON.parse(JSON.stringify(value));

  before(function(done) {
    envKeys.forEach(key => { saved[key] = process.env[key]; });
    process.env.AI_API_KEY = 'synthetic-metering-key';
    process.env.AI_BASE_URL = `${origin}/v1`;
    process.env.AI_MODEL = 'synthetic-metering-model';
    process.env.AI_REQUEST_TIMEOUT_MS = '1000';
    delete process.env.AI_RESEGMENT_REQUEST_OPTIONS;
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
    usage.settleAndRecordCommunicationAiUsage = value => originalUsage({
      ...value,
      recordUsageImpl: async item => { recorded.push(item); }
    });
    const meter = createCareAiMetering({
      env: {
        CARE_NEXT_ENABLED: 'true',
        CARE_AI_PRICE_POLICY: JSON.stringify({
          resegmentCommunicationText: { reservationUnits: 10, fixedUnits: 1, tokensPerUnit: 10 },
          generateCommunicationSentences: { reservationUnits: 10, fixedUnits: 1, tokensPerUnit: 10 }
        })
      },
      runtimeFactory: () => ({
        reserve: (...args) => budget.reserve(...args),
        complete: async (...args) => {
          if (failCompletion) throw new Error('synthetic write failure');
          completionWrites += 1;
          const completed = await budget.complete(...args);
          if (afterCompletion) afterCompletion(completed);
          if (failAfterCommit) throw new Error('synthetic lost storage acknowledgment');
          return completed;
        },
        settle: (...args) => {
          const pending = budget.settle(...args);
          settlements.push(pending);
          return pending;
        }
      }),
      authorizeProfile: async (actor, profile, funding) => {
        if (denyProfile) { const error = new Error('revoked'); error.status = 403; error.code = 'PROFILE_ACCESS_DENIED'; throw error; }
        assert.equal(actor, 'synthetic-user');
        assert.equal(profile, 'synthetic-profile');
        assert.equal(funding, 'synthetic-funding');
      }
    });
    app = express();
    app.use(express.json());
    swaggerTools.initializeMiddleware(YAML.load('./api/swagger/swagger.yaml'), middleware => {
      app.use(middleware.swaggerMetadata());
      app.use((req, res, next) => { req.user = { id: 'synthetic-user' }; next(); });
      app.use(meter);
      app.use(middleware.swaggerValidator());
      app.post('/gpt/communication/resegment', controller.resegmentCommunicationText);
      app.post('/gpt/communication/sentences', controller.generateCommunicationSentences);
      app.use((error, req, res, next) => {
        if (!error) return next();
        return res.status(error.status || 400).json({ error: { message: error.message } });
      });
      done();
    });
  });

  beforeEach(async function() {
    delete process.env.AI_SENTENCE_REQUEST_OPTIONS;
    settlements = [];
    recorded = [];
    docs = {};
    clock = DAY;
    denyProfile = false;
    failCompletion = false;
    completionWrites = 0;
    afterCompletion = null;
    failAfterCommit = false;
    budgetOptions = {
      now: () => clock,
      encryption: createCareCrypto({ test: crypto.randomBytes(32).toString('hex') }, 'test'),
      store: {
        get: async id => clone(docs[id]),
        create: async value => {
          if (docs[value._id]) return false;
          docs[value._id] = clone(value); return true;
        },
        cas: async (id, rev, value) => {
          if (!docs[id] || docs[id].rev !== rev) return false;
          docs[id] = { ...docs[id], ...clone(value) }; return true;
        }
      }
    };
    budget = createCareBudget(budgetOptions);
    await budget.provision('synthetic-funding', {
      owner: 'synthetic-user', familyId: 'synthetic-family', kind: 'family',
      weeklyLimit: 100, startsAt: DAY, expiresAt: 30 * DAY
    });
  });
  afterEach(function() { nock.cleanAll(); });
  after(function() {
    usage.settleAndRecordCommunicationAiUsage = originalUsage;
    envKeys.forEach(key => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
    nock.enableNetConnect();
  });

  function submit(id, body = { text: '别打针', contractVersion: 2 }) {
    return request(app).post('/gpt/communication/resegment')
      .set('X-Care-Funding-Id', 'synthetic-funding')
      .set('X-Care-Profile-Id', 'synthetic-profile')
      .set('Idempotency-Key', id).send(body);
  }
  function provider(tokens, { finish = 'stop', reported = true } = {}) {
    return nock(origin).post('/v1/chat/completions').reply(200, {
      choices: [{ message: { content: JSON.stringify({ tokens }) }, finish_reason: finish }],
      ...(reported ? { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } } : {})
    });
  }
  async function snapshot(restart = false) {
    await Promise.all(settlements);
    return (restart ? createCareBudget(budgetOptions) : budget)
      .snapshot('synthetic-funding', 'synthetic-user', 'synthetic-profile');
  }

  it('settles successful source-preserving output and blocks duplicate provider calls', async function() {
    const upstream = provider(['别', '打针']);
    const response = await submit('success').expect(200);
    assert.equal(response.body.requiresConfirmation, true);
    assert.equal(response.body.sourceText, '别打针');
    assert.equal((await snapshot()).weeklyUsed, 3);
    assert.equal((await snapshot()).pendingRequests.length, 0);
    const replay = await submit('success').expect(200);
    assert.deepEqual(replay.body, response.body);
    assert.equal(replay.headers['x-care-idempotency-replayed'], 'true');
    assert.equal(completionWrites, 1);
    assert.equal(recorded.length, 1);
    assert(upstream.isDone());
  });

  it('settles reported usage when lost negation is rejected, including after service restart', async function() {
    const upstream = provider(['打针']);
    const response = await submit('lost-negation').expect(502);
    assert.equal(response.body.error.code, 'AI_RESEGMENT_SOURCE_MISMATCH');
    assert.match(response.headers['cache-control'], /no-store/);
    assert.equal((await snapshot(true)).weeklyUsed, 3);
    assert.equal((await snapshot(true)).pendingRequests.length, 0);
    budget = createCareBudget(budgetOptions);
    const replay = await submit('lost-negation').expect(502);
    assert.deepEqual(replay.body, response.body);
    assert.equal(replay.headers['x-care-idempotency-replayed'], 'true');
    assert.equal(completionWrites, 1);
    assert.equal(recorded.length, 1);
    assert(upstream.isDone());
  });

  it('settles known consumption of provider output truncated at its limit', async function() {
    provider(['别', '打针'], { finish: 'length' });
    await submit('truncated').expect(502);
    assert.equal((await snapshot()).weeklyUsed, 3);
    assert.equal((await snapshot()).pendingRequests.length, 0);
  });

  it('keeps missing usage pending instead of treating normalized zero as known consumption', async function() {
    provider(['打针'], { reported: false });
    await submit('unknown-usage').expect(502);
    assert.equal((await snapshot()).weeklyUsed, 10);
    assert.equal((await snapshot()).pendingRequests.length, 1);
    assert.equal(settlements.length, 0);
    assert.equal((await submit('unknown-usage').expect(409)).body.code, 'AI_REQUEST_PENDING_RECONCILIATION');
  });

  it('calls the provider once on a connection timeout and keeps the reservation pending', async function() {
    let providerCalls = 0;
    const upstream = nock(origin).post('/v1/chat/completions', () => { providerCalls += 1; return true; })
      .replyWithError({ code: 'ETIMEDOUT', message: 'synthetic timeout' });
    await submit('timeout').expect(502);
    assert.equal((await snapshot()).weeklyUsed, 10);
    assert.equal((await snapshot()).pendingRequests.length, 1);
    assert.equal(recorded.length, 0);
    assert.equal(providerCalls, 1);
    assert(upstream.isDone());
    budget = createCareBudget(budgetOptions);
    assert.equal((await submit('timeout').expect(409)).body.code, 'AI_REQUEST_PENDING_RECONCILIATION');
    assert.equal(providerCalls, 1);
  });

  it('releases invalid input before provider execution and requires explicit funding', async function() {
    await submit('blank', { text: ' ' }).expect(400);
    assert.equal((await snapshot()).weeklyUsed, 0);
    assert.equal((await snapshot()).pendingRequests.length, 0);
    const missing = await request(app).post('/gpt/communication/resegment')
      .send({ text: '别打针' }).expect(400);
    assert.equal(missing.body.code, 'EXPLICIT_FUNDING_REQUIRED');
    assert.equal(recorded.length, 0);
  });

  it('deduplicates concurrent requests while the provider is still working', async function() {
    let started;
    const seen = new Promise(resolve => { started = resolve; });
    let count = 0;
    const upstream = nock(origin).post('/v1/chat/completions', () => { count += 1; started(); return true; })
      .delay(100).reply(200, { choices: [{ message: { content: '{"tokens":["别","打针"]}' }, finish_reason: 'stop' }], usage: { total_tokens: 30 } });
    const first = submit('concurrent').then(response => response);
    await seen;
    assert.equal((await submit('concurrent').expect(409)).body.code, 'AI_REQUEST_PENDING_RECONCILIATION');
    assert.equal((await first).status, 200);
    assert.equal((await submit('concurrent').expect(200)).headers['x-care-idempotency-replayed'], 'true');
    assert.equal(count, 1); assert.equal(completionWrites, 1); assert(upstream.isDone());
    assert.equal((await snapshot()).weeklyUsed, 3);
  });

  it('persists the result before sending so a lost caller response can be recovered after restart', async function() {
    provider(['别', '打针']);
    const first = await submit('lost-client-response').expect(200);
    // Treat the received body as lost at the client. The durable result must
    // already exist when HTTP delivery finishes; no provider fixture is added.
    const state = budgetOptions.encryption.open(docs['synthetic-funding'].sealed, 'funding:synthetic-funding');
    assert.deepEqual(state.receipts['synthetic-user:lost-client-response'].response.body, first.body);
    budget = createCareBudget(budgetOptions);
    assert.deepEqual((await submit('lost-client-response').expect(200)).body, first.body);
    assert.equal(recorded.length, 1); assert.equal(completionWrites, 1);
    assert.equal((await snapshot()).weeklyUsed, 3);
  });

  it('does not replay across revoked profile or funding grants, or a changed body', async function() {
    provider(['别', '打针']); await submit('revoke').expect(200);
    denyProfile = true;
    assert.equal((await submit('revoke').expect(403)).body.code, 'PROFILE_ACCESS_DENIED');
    denyProfile = false;
    assert.equal((await submit('revoke', { text: '打针', contractVersion: 2 }).expect(409)).body.code, 'USAGE_ID_REUSED');
    const state = budgetOptions.encryption.open(docs['synthetic-funding'].sealed, 'funding:synthetic-funding');
    state.grants['synthetic-user'].revoked = true;
    docs['synthetic-funding'].sealed = budgetOptions.encryption.seal(state, 'funding:synthetic-funding');
    assert.equal((await submit('revoke').expect(403)).body.code, 'FUNDING_ACCESS_DENIED');
    assert.equal(recorded.length, 1); assert.equal(completionWrites, 1);
  });

  it('fails closed on completion storage failure without returning an unrecorded success or invoking again', async function() {
    provider(['别', '打针']); failCompletion = true;
    const result = await submit('storage-failure').expect(503);
    assert.equal(result.body.code, 'AI_RESPONSE_PERSISTENCE_UNAVAILABLE');
    assert.equal(result.headers['x-care-usage-state'], 'pending');
    assert.equal((await snapshot()).weeklyUsed, 10);
    failCompletion = false; budget = createCareBudget(budgetOptions);
    assert.equal((await submit('storage-failure').expect(409)).body.code, 'AI_REQUEST_PENDING_RECONCILIATION');
    assert.equal(recorded.length, 1);
  });

  it('expires result text after one day but preserves the no-reexecution tombstone', async function() {
    provider(['别', '打针']); await submit('expired-result').expect(200);
    clock += DAY;
    assert.equal((await submit('expired-result').expect(409)).body.code, 'AI_REQUEST_ALREADY_COMPLETED');
    const state = budgetOptions.encryption.open(docs['synthetic-funding'].sealed, 'funding:synthetic-funding');
    assert.equal(state.receipts['synthetic-user:expired-result'].response, undefined);
    assert.equal(state.receipts['synthetic-user:expired-result'].status, 'settled');
    assert.equal(recorded.length, 1); assert.equal((await snapshot()).weeklyUsed, 3);
  });

  it('recovers after the HTTP caller actually disconnects while the provider is working', async function() {
    let started;
    const providerStarted = new Promise(resolve => { started = resolve; });
    const persisted = new Promise(resolve => { afterCompletion = resolve; });
    const upstream = nock(origin).post('/v1/chat/completions', () => { started(); return true; })
      .delay(100).reply(200, { choices: [{ message: { content: '{"tokens":["别","打针"]}' }, finish_reason: 'stop' }], usage: { total_tokens: 30 } });
    const outgoing = submit('caller-disconnected');
    outgoing.end(() => {});
    await providerStarted;
    outgoing.abort();
    await persisted;
    budget = createCareBudget(budgetOptions);
    const retry = await submit('caller-disconnected').expect(200);
    assert.equal(retry.headers['x-care-idempotency-replayed'], 'true');
    assert.equal(retry.body.sourceText, '别打针');
    assert.equal((await snapshot()).weeklyUsed, 3);
    assert.equal(completionWrites, 1); assert.equal(recorded.length, 1); assert(upstream.isDone());
  });

  it('recovers a committed result even when the storage acknowledgment was lost', async function() {
    provider(['别', '打针']); failAfterCommit = true;
    assert.equal((await submit('lost-storage-ack').expect(503)).body.code, 'AI_RESPONSE_PERSISTENCE_UNAVAILABLE');
    failAfterCommit = false; budget = createCareBudget(budgetOptions);
    assert.equal((await submit('lost-storage-ack').expect(200)).headers['x-care-idempotency-replayed'], 'true');
    assert.equal((await snapshot()).weeklyUsed, 3); assert.equal(completionWrites, 1); assert.equal(recorded.length, 1);
  });

  it('also replays sentence generation without another SDK request or charge', async function() {
    const upstream = nock(origin).post('/v1/chat/completions').reply(200, {
      choices: [{ message: { content: '我想喝水。\n请给我水。' }, finish_reason: 'stop' }], usage: { total_tokens: 30 }
    });
    const send = () => request(app).post('/gpt/communication/sentences')
      .set('X-Care-Funding-Id', 'synthetic-funding').set('X-Care-Profile-Id', 'synthetic-profile')
      .set('Idempotency-Key', 'sentence-replay').send({ pictogramLabels: ['我', '喝水'], candidateCount: 2 });
    const first = await send().expect(200); budget = createCareBudget(budgetOptions);
    const second = await send().expect(200);
    assert.deepEqual(second.body, first.body); assert.equal(second.headers['x-care-idempotency-replayed'], 'true');
    assert.equal((await snapshot()).weeklyUsed, 3); assert.equal(completionWrites, 1); assert.equal(recorded.length, 1); assert(upstream.isDone());
  });

  it('inherits bounded sentence options and persists three real controller candidates for replay', async function() {
    process.env.AI_RESEGMENT_REQUEST_OPTIONS = '{"enable_thinking":false,"max_tokens":2048,"response_format":"json_schema"}';
    const upstream = nock(origin).post('/v1/chat/completions', body =>
      body.enable_thinking === false && body.max_tokens === 2048 && body.response_format.type === 'text'
    ).reply(200, { choices: [{ message: { content: '我想喝水。\n我需要喝水。\n请给我水。' }, finish_reason: 'stop' }], usage: { total_tokens: 30 } });
    const send = () => request(app).post('/gpt/communication/sentences')
      .set('X-Care-Funding-Id', 'synthetic-funding').set('X-Care-Profile-Id', 'synthetic-profile')
      .set('Idempotency-Key', 'cai_' + 'b'.repeat(64)).send({ pictogramLabels: ['我', '喝水'], candidateCount: 3 });
    try {
      const first = await send().expect(200);
      assert.equal(first.body.candidates.length, 3);
      budget = createCareBudget(budgetOptions);
      const replay = await send().expect(200);
      assert.deepEqual(replay.body, first.body);
      assert.equal(replay.headers['x-care-idempotency-replayed'], 'true');
      assert.equal((await snapshot()).weeklyUsed, 3);
      assert.equal(recorded.length, 1); assert.equal(completionWrites, 1); assert(upstream.isDone());
    } finally { delete process.env.AI_RESEGMENT_REQUEST_OPTIONS; }
  });

  it('rejects invalid sentence format before starting the provider and releases the reservation', async function() {
    process.env.AI_SENTENCE_REQUEST_OPTIONS = '{"response_format":"json_object"}';
    const result = await request(app).post('/gpt/communication/sentences')
      .set('X-Care-Funding-Id', 'synthetic-funding').set('X-Care-Profile-Id', 'synthetic-profile')
      .set('Idempotency-Key', 'sentence-invalid-config').send({ pictogramLabels: ['喝水'], candidateCount: 3 }).expect(503);
    assert.equal(result.body.error.code, 'AI_SENTENCE_CONFIGURATION_INVALID');
    const current = await snapshot();
    assert.equal(current.weeklyUsed, 0); assert.equal(current.pendingRequests.length, 0);
    assert.equal(recorded.length, 0);
  });

  it('replays new canonical IDs when equivalent JSON object keys arrive in a different order', async function() {
    const upstream = provider(['别', '打针']);
    const id = 'cai_' + 'a'.repeat(64);
    const first = await submit(id, { text: '别打针', contractVersion: 2, pictogramVocabulary: ['打针'], unmatchedTokens: ['别'] }).expect(200);
    budget = createCareBudget(budgetOptions);
    const second = await submit(id, { unmatchedTokens: ['别'], pictogramVocabulary: ['打针'], contractVersion: 2, text: '别打针' }).expect(200);
    assert.deepEqual(second.body, first.body);
    assert.equal(second.headers['x-care-idempotency-replayed'], 'true');
    assert.equal(completionWrites, 1); assert.equal(recorded.length, 1);
    assert.equal((await snapshot()).weeklyUsed, 3); assert(upstream.isDone());
    assert.equal((await submit(id, { unmatchedTokens: ['别'], pictogramVocabulary: ['其他'], contractVersion: 2, text: '别打针' }).expect(409)).body.code, 'USAGE_ID_REUSED');
    // A refreshed catalog or missing-word list must not turn the same source
    // intent into another paid request, including after losing client metadata.
    assert.equal((await submit(id, { unmatchedTokens: [], pictogramVocabulary: ['打针'], contractVersion: 2, text: '别打针' }).expect(409)).body.code, 'USAGE_ID_REUSED');
    assert.equal(completionWrites, 1); assert.equal(recorded.length, 1);
    assert.equal((await snapshot()).weeklyUsed, 3);
  });

  it('preserves the existing ordered fingerprint rule for historical request IDs', async function() {
    provider(['别', '打针']);
    await submit('historical-key-order', { text: '别打针', contractVersion: 2 }).expect(200);
    assert.equal((await submit('historical-key-order', { contractVersion: 2, text: '别打针' }).expect(409)).body.code, 'USAGE_ID_REUSED');
    assert.equal(completionWrites, 1); assert.equal(recorded.length, 1);
  });
});

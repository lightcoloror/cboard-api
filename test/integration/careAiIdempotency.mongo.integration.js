'use strict';
// Standalone synthetic acceptance. Never import app.js/db.js or a saved .env.
const assert = require('assert').strict;
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { createCareAiTestProvider } = require('./careAiIdempotency.provider.fixture');

function testDatabase(uri) {
  const match = /^mongodb:\/\/[^/?#]+\/(care_test_[a-f0-9]{16,64})(?:\?[^#]*)?$/.exec(uri || '');
  if (!match) throw Object.assign(new Error('Explicit unique care_test_<16+hex> Mongo URI required'), { code: 'ISOLATED_DATABASE_REQUIRED' });
  return match[1];
}

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function send(base, pathname, { token, profile, funding, id, body } = {}) {
  let outgoing;
  const promise = new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    outgoing = http.request(new URL(pathname, base), { method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(profile ? { 'X-Care-Profile-Id': profile } : {}),
        ...(funding ? { 'X-Care-Funding-Id': funding } : {}),
        ...(id ? { 'Idempotency-Key': id } : {}) } }, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(raw) }); }
        catch (error) { reject(error); }
      });
    });
    outgoing.setTimeout(15000, () => outgoing.destroy(new Error('Synthetic caller deadline')));
    outgoing.on('error', reject); outgoing.end(data);
  });
  return { promise, abort: () => outgoing.destroy(new Error('Synthetic caller disconnected')) };
}

async function main() {
  const uri = process.env.CARE_TEST_MONGO_URI;
  const database = testDatabase(uri);
  const marker = crypto.randomBytes(16).toString('hex');
  const started = Date.now();
  const cases = [];
  const mongoose = require('mongoose');
  let provider;
  let server;
  let claimed = false;
  let cleanupDone = false;
  let base;
  let testControl;
  const serving = process.argv.includes('--serve');
  const bindHost = serving ? process.env.CARE_TEST_HTTP_HOST || '127.0.0.1' : '127.0.0.1';
  const bindPort = serving ? Number(process.env.CARE_TEST_HTTP_PORT || 0) : 0;
  assert(['127.0.0.1', '0.0.0.0'].includes(bindHost));
  assert(Number.isInteger(bindPort) && bindPort >= 0 && bindPort <= 65535);
  // Config modules historically call dotenv.config themselves. Prevent those
  // reads in this standalone test instead of importing any saved credentials.
  require('dotenv').config = () => ({ parsed: {} });
  process.env.NODE_ENV = 'test';
  process.env.MONGO_URL = uri;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.JWT_ISSUER = 'synthetic-care-ai-test';
  process.env.CARE_COLLABORATION_ENABLED = 'true';
  process.env.CARE_NEXT_ENABLED = 'true';
  process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
  process.env.CARE_ENCRYPTION_ACTIVE_KEY = 'test';
  process.env.CARE_ENCRYPTION_KEYS = JSON.stringify({ test: crypto.randomBytes(32).toString('hex') });
  process.env.CARE_AI_PRICE_POLICY = JSON.stringify({
    resegmentCommunicationText: { reservationUnits: 10, fixedUnits: 1, tokensPerUnit: 10 },
    generateCommunicationSentences: { reservationUnits: 10, fixedUnits: 1, tokensPerUnit: 10 }
  });
  const connect = () => mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true,
    autoIndex: false, serverSelectionTimeoutMS: 15000 });
  try {
    await connect();
    assert.equal(mongoose.connection.name, database, 'Mongo selected a different database');
    assert.equal((await mongoose.connection.db.listCollections().toArray()).length, 0, 'must start with an empty isolated database');
    await mongoose.connection.db.collection('care_ai_test_guard').insertOne({ _id: marker, database, syntheticOnly: true });
    claimed = true;
    const topology = await mongoose.connection.db.admin().command({ isMaster: 1 });
    assert(topology.setName, 'Replica set required; never disable lifecycle transactions to make the test pass');
    for (const name of ['carefamilies', 'careprofiles', 'careaccounts', 'communicators', 'careaccountlifecycles',
      'carefundings', 'devicesessions', 'communicationaiusages', 'test_users']) {
      await mongoose.connection.db.createCollection(name);
    }
    provider = await createCareAiTestProvider();
    process.env.AI_API_KEY = 'synthetic-care-ai-provider';
    process.env.AI_BASE_URL = `${provider.origin}/v1`;
    process.env.AI_MODEL = 'synthetic-care-model';
    process.env.AI_REQUEST_TIMEOUT_MS = '3000';
    delete process.env.AI_RESEGMENT_REQUEST_OPTIONS;
    delete process.env.AI_SENTENCE_REQUEST_OPTIONS;
    for (const key of ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_DEPLOYMENT']) delete process.env[key];

    const express = require('express');
    const swaggerTools = require('swagger-tools');
    const YAML = require('yamljs');
    const auth = require('../../api/helpers/auth');
    const sessions = require('../../api/helpers/deviceSessions');
    const controller = require('../../api/controllers/gpt');
    const { createCareAiMetering } = require('../../api/helpers/careAiMetering');
    const careRuntime = require('../../api/helpers/careRuntime');
    const budgetRuntime = require('../../api/helpers/careBudgetRuntime');
    const usage = require('../../api/helpers/communicationAiUsage');
    const Usage = require('../../api/models/CommunicationAiUsage');
    await Usage.createIndexes();
    const encryption = require('../../api/helpers/careCrypto').fromEnvironment();
    const subscription = require('../../api/helpers/careSubscription').createCareSubscription({ store: careRuntime.store, encryption });
    const spec = YAML.load(path.resolve(__dirname, '../../api/swagger/swagger.yaml'));
    const authenticate = require('../../api/helpers/authenticateBearer').createBearerAuthenticator({ auth, sessions,
      users: { getById: id => mongoose.connection.collection('test_users').findOne({ id }) } });

    // Faults are confined to this isolated test HTTP instance. All reservation,
    // encryption, CAS and replay still use the real Mongo-backed runtime.
    const completionFaults = new Map();
    function meteringRuntime() {
      const service = budgetRuntime.createRuntime();
      const complete = service.complete;
      return { ...service, async complete(fundingId, actor, requestId, ...args) {
        const fault = completionFaults.get(requestId);
        completionFaults.delete(requestId);
        if (fault === 'before') throw new Error('synthetic completion storage failure');
        const result = await complete(fundingId, actor, requestId, ...args);
        if (fault === 'after') throw new Error('synthetic completion acknowledgement loss');
        return result;
      } };
    }
    async function startApi() {
      const app = express(); app.use(express.json({ limit: '1mb' }));
      // These controls exist only in this test entrypoint, never in app.js.
      app.use('/_synthetic', async (req, res) => {
        if (!testControl || req.headers.authorization !== `Bearer ${testControl.secret}`) return res.status(404).end();
        try { await testControl.handle(req, res); }
        catch (error) { res.status(500).json({ code: 'TEST_CONTROL_ERROR' }); }
      });
      await new Promise(resolve => swaggerTools.initializeMiddleware(spec, middleware => {
        app.use(middleware.swaggerMetadata());
        app.use(middleware.swaggerSecurity({ Bearer: async (req, _, token, cb) => {
          try { if (await authenticate(req, token)) return cb(); }
          catch (_) { const error = new Error('Synthetic authentication unavailable'); error.statusCode = 503; return cb(error); }
          const error = new Error('Unauthorized'); error.statusCode = 401; return cb(error);
        } }));
        app.use(createCareAiMetering({ runtimeFactory: meteringRuntime }));
        app.use(middleware.swaggerValidator());
        app.post('/gpt/communication/resegment', controller.resegmentCommunicationText);
        app.post('/gpt/communication/sentences', controller.generateCommunicationSentences);
        app.use(middleware.swaggerRouter({ controllers: path.resolve(__dirname, '../../api/controllers'), ignoreMissingHandlers: true }));
        app.use((error, req, res, next) => res.status(error.statusCode || error.status || 500).json({ code: 'TEST_HTTP_ERROR' }));
        resolve();
      }));
      server = app.listen(bindPort, bindHost);
      await new Promise(resolve => server.once('listening', resolve));
      base = `http://127.0.0.1:${server.address().port}`;
    }
    await startApi();

    async function fixture(label, delegated = false) {
      const owner = new mongoose.Types.ObjectId().toString();
      const actor = delegated ? new mongoose.Types.ObjectId().toString() : owner;
      for (const id of [...new Set([owner, actor])]) {
        await mongoose.connection.collection('test_users').insertOne({ id, email: `${id}@example.test`, authVersion: 0 });
      }
      const care = careRuntime.createRuntime();
      const family = await care.createFamily(owner, { name: `合成幂等-${label}` });
      await subscription.activate({ familyId: family.id, payerId: owner, receiptId: `test-${label}`,
        startsAt: Date.now() - 1000, expiresAt: Date.now() + 86400000 });
      const profile = await care.createProfile(owner, { familyId: family.id, name: '合成患者' });
      if (delegated) {
        const invite = await care.command(owner, profile.id, { action: 'invite', operationId: `invite-${label}`, permissions: ['read'] });
        await care.accept(actor, invite.token);
      }
      const funding = `test-${crypto.randomBytes(12).toString('hex')}`;
      await budgetRuntime.createRuntime().provision(funding, { owner, kind: 'family', familyId: family.id,
        weeklyLimit: 100, startsAt: Date.now() - 1000, expiresAt: Date.now() + 86400000 });
      if (delegated) await budgetRuntime.createRuntime().delegate(funding, owner, { member: actor, profileIds: [profile.id], limit: 10 });
      const sid = await sessions.create(actor, '合成自动验收设备');
      const token = auth.issueToken({ id: actor, email: `${actor}@example.test`, authVersion: 0, sid });
      return { actor, owner, token, sid, profile: profile.id, family: family.id, funding };
    }
    const paths = { resegment: '/gpt/communication/resegment', sentences: '/gpt/communication/sentences' };
    const bodies = { resegment: { text: '别打针', contractVersion: 2 }, sentences: { pictogramLabels: ['我', '喝水'], candidateCount: 2 } };
    const content = kind => kind === 'resegment' ? '{"tokens":["别","打针"]}' : '我喝水。\n我的意思是：我喝水。';
    const idFor = value => `cai_${crypto.createHash('sha256').update(value).digest('hex')}`;
    const submit = (f, kind, id, body = bodies[kind]) => send(base, paths[kind], { ...f, id, body });
    const snapshot = f => budgetRuntime.createRuntime().snapshot(f.funding, f.actor, f.profile);
    const usageCount = async f => (await usage.getMonthlyUsage({ userId: f.actor })).requestCount;
    async function receipt(f, id) {
      const doc = await budgetRuntime.Funding.findById(f.funding).lean().exec();
      return encryption.open(doc.sealed, `funding:${f.funding}`).receipts[`${f.actor}:${id}`];
    }

    if (serving) {
      const fs = require('fs');
      const file = process.env.CARE_TEST_FIXTURE_FILE;
      assert(file && path.isAbsolute(file), 'CARE_TEST_FIXTURE_FILE must be a new absolute path');
      const f = await fixture('browser');
      let stop;
      let stopTimer;
      const stopped = new Promise(resolve => { stop = resolve; });
      const secret = crypto.randomBytes(32).toString('hex');
      testControl = { secret, async handle(req, res) {
        if (req.method === 'GET' && req.path === '/state') {
          const doc = await budgetRuntime.Funding.findById(f.funding).lean().exec();
          const state = encryption.open(doc.sealed, `funding:${f.funding}`);
          return res.json({ syntheticOnly: true, provider: provider.stats, funding: await snapshot(f),
            requestCount: await usageCount(f), receipts: Object.values(state.receipts).map(r => ({
              requestId: r.requestId, status: r.status, actual: r.actual, reserved: r.reserved,
              hasResult: Boolean(r.response), operationFingerprint: r.fingerprint })) });
        }
        if (req.method === 'POST' && req.path === '/provider') {
          const kind = req.body.operation;
          const mode = req.body.mode || 'success';
          if (!['resegment', 'sentences'].includes(kind) || !['success', 'delay', 'timeout', 'usage-unknown'].includes(mode)) return res.status(400).end();
          provider.enqueue({ content: content(kind), timeout: mode === 'timeout', delayMs: mode === 'delay' ? 1800 : 0, usage: mode === 'usage-unknown' ? false : true });
          return res.json({ queued: true, syntheticOnly: true });
        }
        if (req.method === 'POST' && req.path === '/stop') { res.json({ stopping: true }); return stop(); }
        return res.status(404).end();
      } };
      fs.writeFileSync(file, JSON.stringify({ ...f, base, controlToken: secret, syntheticOnly: true }), { mode: 0o600, flag: 'wx' });
      console.log(JSON.stringify({ result: 'serving', fixtureFile: file, base, syntheticOnly: true, expiresAfterMinutes: 30 }));
      const onSignal = () => stop();
      process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
      stopTimer = setTimeout(stop, 30 * 60 * 1000);
      await stopped;
      clearTimeout(stopTimer); process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal);
      // Only remove the exact file this invocation created after matching its secret.
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(saved.controlToken, secret, 'fixture cleanup ownership mismatch');
      fs.unlinkSync(file);
      console.log(JSON.stringify({ result: 'fixture-stopped', syntheticOnly: true }));
      return;
    }

    for (const kind of Object.keys(paths)) {
      const f = await fixture(`${kind}-concurrent`, true);
      const id = idFor(`${kind}-concurrent`);
      const calls = provider.stats.calls;
      const pendingProvider = provider.enqueue({ content: content(kind), hold: true });
      const completed = [];
      const simultaneous = Array.from({ length: 4 }, () => submit(f, kind, id).promise.then(result => { completed.push(result); return result; }));
      await waitFor(() => provider.stats.calls === calls + 1, 'provider did not start');
      await waitFor(() => completed.length === 3, 'concurrent duplicates did not return while first provider held');
      for (const duplicate of completed) {
        assert.equal(duplicate.status, 409); assert.equal(duplicate.body.code, 'AI_REQUEST_PENDING_RECONCILIATION');
      }
      const rejectedOther = await submit(f, kind, idFor(`${kind}-over-limit`)).promise;
      assert.equal(rejectedOther.status, 429); assert.equal(rejectedOther.body.code, 'DELEGATED_QUOTA_EXCEEDED');
      pendingProvider.release();
      const completedResponses = await Promise.all(simultaneous);
      assert.equal(completedResponses.filter(result => result.status === 200).length, 1);
      const original = completedResponses.find(result => result.status === 200);
      assert.equal(original.status, 200);
      const beforeReplay = await budgetRuntime.Funding.findById(f.funding).lean().exec();
      const replay = await submit(f, kind, id).promise;
      assert.equal(replay.status, 200); assert.equal(replay.headers['x-care-idempotency-replayed'], 'true');
      assert.deepEqual(replay.body, original.body);
      const reordered = Object.fromEntries(Object.entries(bodies[kind]).reverse());
      const canonicalReplay = await submit(f, kind, id, reordered).promise;
      assert.equal(canonicalReplay.status, 200);
      assert.equal(canonicalReplay.headers['x-care-idempotency-replayed'], 'true');
      if (kind === 'resegment') {
        const contextChanged = await submit(f, kind, id, { ...bodies[kind], unmatchedTokens: ['打针'] }).promise;
        assert.equal(contextChanged.status, 409); assert.equal(contextChanged.body.code, 'USAGE_ID_REUSED');
      }
      assert.equal((await budgetRuntime.Funding.findById(f.funding).lean().exec()).rev, beforeReplay.rev);
      assert.equal((await snapshot(f)).weeklyUsed, 3); assert.equal((await snapshot(f)).delegatedUsed, 3);
      assert.equal(await usageCount(f), 1); assert.equal(provider.stats.calls - calls, 1);
      cases.push(`${kind}: concurrent-dedup-and-delegated-cap`);

      const aborted = await fixture(`${kind}-abort`);
      const abortId = idFor(`${kind}-abort`);
      const abortCalls = provider.stats.calls;
      provider.enqueue({ content: content(kind), delayMs: 150 });
      const caller = submit(aborted, kind, abortId);
      const ignoredDisconnect = caller.promise.catch(error => error);
      await waitFor(() => provider.stats.calls === abortCalls + 1, 'abort provider did not start');
      caller.abort(); await ignoredDisconnect;
      await waitFor(async () => (await receipt(aborted, abortId)).status === 'settled', 'aborted caller result was not persisted');
      // Tear down the HTTP instance and Mongo connection. The next app instance
      // must recover from real Mongo state, not an in-process receipt cache.
      await new Promise(resolve => server.close(resolve)); server = null;
      await mongoose.disconnect(); await connect(); await startApi();
      const recovered = await submit(aborted, kind, abortId).promise;
      assert.equal(recovered.status, 200); assert.equal(recovered.headers['x-care-idempotency-replayed'], 'true');
      assert.deepEqual(recovered.body, (await receipt(aborted, abortId)).response.body);
      assert.equal((await snapshot(aborted)).weeklyUsed, 3); assert.equal(await usageCount(aborted), 1);
      assert.equal(provider.stats.calls - abortCalls, 1);
      cases.push(`${kind}: caller-abort-reconnect-result-recovery`);

      const unknown = await fixture(`${kind}-timeout`);
      const unknownId = idFor(`${kind}-timeout`);
      const unknownCalls = provider.stats.calls;
      provider.enqueue({ content: content(kind), timeout: true });
      const timedOut = await submit(unknown, kind, unknownId).promise;
      assert.equal(timedOut.status, 502); assert.equal(timedOut.headers['x-care-usage-state'], 'pending');
      const retried = await submit(unknown, kind, unknownId).promise;
      assert.equal(retried.status, 409); assert.equal(retried.body.code, 'AI_REQUEST_PENDING_RECONCILIATION');
      assert.equal((await snapshot(unknown)).weeklyUsed, 10);
      assert.equal((await receipt(unknown, unknownId)).status, 'reserved');
      assert.equal(await usageCount(unknown), 0); assert.equal(provider.stats.calls - unknownCalls, 1);
      cases.push(`${kind}: real-upstream-timeout-stays-pending`);

      for (const phase of ['before', 'after']) {
        const storage = await fixture(`${kind}-storage-${phase}`);
        const storageId = idFor(`${kind}-storage-${phase}`);
        const storageCalls = provider.stats.calls;
        completionFaults.set(storageId, phase);
        provider.enqueue({ content: content(kind) });
        const failed = await submit(storage, kind, storageId).promise;
        assert.equal(failed.status, 503);
        assert.equal(failed.body.code, 'AI_RESPONSE_PERSISTENCE_UNAVAILABLE');
        await new Promise(resolve => server.close(resolve)); server = null;
        await mongoose.disconnect(); await connect(); await startApi();
        const retry = await submit(storage, kind, storageId).promise;
        if (phase === 'before') {
          assert.equal(retry.status, 409);
          assert.equal(retry.body.code, 'AI_REQUEST_PENDING_RECONCILIATION');
          assert.equal((await receipt(storage, storageId)).status, 'reserved');
          assert.equal((await snapshot(storage)).weeklyUsed, 10);
        } else {
          assert.equal(retry.status, 200);
          assert.equal(retry.headers['x-care-idempotency-replayed'], 'true');
          assert.equal((await receipt(storage, storageId)).status, 'settled');
          assert.equal((await snapshot(storage)).weeklyUsed, 3);
        }
        assert.equal(provider.stats.calls - storageCalls, 1);
        assert.equal(await usageCount(storage), 1);
        cases.push(`${kind}: completion-${phase}-write-failure-restart-no-second-execution`);
      }

      const other = await fixture(`${kind}-other-family`);
      const isolatedCalls = provider.stats.calls;
      const wrongProfile = await submit({ ...f, profile: other.profile }, kind, id).promise;
      assert.equal(wrongProfile.status, 403);
      const wrongFunding = await submit({ ...f, funding: other.funding }, kind, id).promise;
      assert.equal(wrongFunding.status, 403);
      await budgetRuntime.createRuntime().delegate(f.funding, f.owner, { member: f.actor, profileIds: [f.profile], limit: 10, revoked: true });
      const revoked = await submit(f, kind, id).promise;
      assert.equal(revoked.status, 403); assert.equal(revoked.body.code, 'FUNDING_ACCESS_DENIED');
      assert.equal((await snapshot(other)).weeklyUsed, 0);
      assert.equal(await usageCount(f), 1); assert.equal(provider.stats.calls, isolatedCalls);
      cases.push(`${kind}: cross-family-and-revoked-replay-denied`);
    }

    const three = await fixture('sentence-options-three');
    process.env.AI_RESEGMENT_REQUEST_OPTIONS = '{"max_tokens":2048,"enable_thinking":false,"response_format":"json_object"}';
    let sentenceRequest;
    const threeCalls = provider.stats.calls;
    const threeBody = { pictogramLabels: ['我', '喝水'], candidateCount: 3 };
    provider.enqueue({ content: '我喝水。\n我的意思是：我喝水。\n我想表达的是：我喝水。', observeRequest: value => { sentenceRequest = value; } });
    const threeId = idFor('sentence-options-three');
    const firstThree = await submit(three, 'sentences', threeId, threeBody).promise;
    assert.equal(firstThree.status, 200); assert.equal(firstThree.body.candidates.length, 3);
    assert.equal(sentenceRequest.max_tokens, 2048); assert.equal(sentenceRequest.enable_thinking, false);
    assert.deepEqual(sentenceRequest.response_format, { type: 'text' });
    await new Promise(resolve => server.close(resolve)); server = null;
    await mongoose.disconnect(); await connect(); await startApi();
    const restoredThree = await submit(three, 'sentences', threeId, threeBody).promise;
    assert.equal(restoredThree.headers['x-care-idempotency-replayed'], 'true');
    assert.deepEqual(restoredThree.body, firstThree.body);
    assert.equal(provider.stats.calls - threeCalls, 1); assert.equal(await usageCount(three), 1);
    assert.equal((await snapshot(three)).weeklyUsed, 3);
    delete process.env.AI_RESEGMENT_REQUEST_OPTIONS;
    cases.push('sentences: inherited-format-three-candidates-and-restart-replay');

    provider.assertConsumed();
    const rawFunding = await budgetRuntime.Funding.find({}).lean().exec();
    const raw = JSON.stringify(rawFunding);
    for (const text of ['别打针', '我喝水', 'synthetic-care-ai-provider']) assert(!raw.includes(text), 'funding storage must remain encrypted');
    cases.push('funding-results-encrypted-at-rest');
    await new Promise(resolve => server.close(resolve)); server = null;
    await provider.close(); provider = null;
    assert.equal(mongoose.connection.name, database);
    assert(await mongoose.connection.db.collection('care_ai_test_guard').findOne({ _id: marker, database }));
    await mongoose.connection.dropDatabase(); cleanupDone = true; claimed = false;
    await mongoose.disconnect();
    console.log(JSON.stringify({ result: 'passed', database, realMongoReplicaSet: true,
      realLifecycleTransactions: true, realBearerAndDeviceSessions: true, realSwaggerSdkHttp: true,
      externalAiProviderExecuted: false, realModelCost: 0, syntheticOnly: true,
      productionDatabaseTouched: false, temporaryDatabaseRemoved: cleanupDone,
      cases, caseCount: cases.length, elapsedMs: Date.now() - started }));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (provider) await provider.close();
    if (claimed && mongoose.connection.readyState === 1) {
      assert.equal(mongoose.connection.name, database, 'cleanup database guard failed');
      assert(await mongoose.connection.db.collection('care_ai_test_guard').findOne({ _id: marker, database }), 'cleanup marker guard failed');
      await mongoose.connection.dropDatabase();
      if (serving) console.log(JSON.stringify({ result: 'fixture-cleaned', database, temporaryDatabaseRemoved: true, syntheticOnly: true }));
    }
    await mongoose.disconnect();
  }
}

if (require.main === module) main().catch(error => {
  const message = String(error.message || '').replace(/mongodb:\/\/\S+/g, '[redacted Mongo URI]');
  const location = String(error.stack || '').split('\n').find(line => line.includes('careAiIdempotency.mongo.integration.js:'));
  console.error(JSON.stringify({ result: 'failed', code: error.code || error.name, message, location }));
  process.exitCode = 1;
});
module.exports = { main, testDatabase };

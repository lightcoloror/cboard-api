'use strict';
// Synthetic HTTP/Mongo acceptance only; no production config, account, or
// provider is loaded.  Requires an explicitly named isolated database.
const assert = require('assert').strict;
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');
const path = require('path');

async function main() {
  const uri = process.env.CARE_TEST_MONGO_URI;
  if (!uri || !/^mongodb:\/\/[^/]+\/care_test_[a-f0-9]+$/.test(uri)) throw new Error('Explicit isolated care_test database required');
  const databaseName = uri.split('/').pop();
  process.env.CARE_NEXT_ENABLED = 'true'; process.env.CARE_PUBLIC_TRIAL_ENABLED = 'true';
  process.env.CARE_TRIAL_ACCOUNT_HOURLY_LIMIT = '3'; process.env.CARE_TRIAL_IP_HOURLY_LIMIT = '50';
  process.env.CARE_TRIAL_POLICY_JSON = JSON.stringify({ version: 'http-mongo-v1', trialUnits: 12, weeklyLimit: 4, trialDurationMs: 3 * 86400000, subscriptionDurationMs: 7 * 86400000 });
  process.env.CARE_ENCRYPTION_ACTIVE_KEY = 'test'; process.env.CARE_ENCRYPTION_KEYS = JSON.stringify({ test: crypto.randomBytes(32).toString('hex') });
  await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  let server;
  try {
    const User = require('../../api/models/User'); const { Family } = require('../../api/models/CareWorkspace');
    const { createCareCrypto } = require('../../api/helpers/careCrypto'); const encryption = createCareCrypto(JSON.parse(process.env.CARE_ENCRYPTION_KEYS), 'test');
    const auth = require('../../api/helpers/auth'); const sessions = require('../../api/helpers/deviceSessions');
    // Reuse the production serialization contract: it supplies `id` and the
    // non-enumerable authVersion that authenticateBearer expects.
    const authenticate = require('../../api/helpers/authenticateBearer').createBearerAuthenticator({ auth, sessions, users: User });
    const ids = ['a', 'b', 'c'].map(() => new mongoose.Types.ObjectId().toString()); const [a, b, c] = ids;
    // Satisfy the production User schema instead of bypassing its required
    // name/password validators; credentials remain synthetic and unused.
    await User.create(ids.map((id, index) => ({ _id: id, name: `Synthetic Trial ${index}`, email: `trial-${index}@example.test`, password: 'synthetic-password', authVersion: 0 })));
    await Family.create([
      { _id: 'family-a', owner: a, rev: 0, sealed: encryption.seal({ name: 'a', subscription: null }, 'family:family-a') },
      { _id: 'family-b', owner: a, rev: 0, sealed: encryption.seal({ name: 'b', subscription: null }, 'family:family-b') },
      { _id: 'family-c', owner: c, rev: 0, sealed: encryption.seal({ name: 'c', subscription: null }, 'family:family-c') }
    ]);
    const token = async id => auth.issueToken({ id, email: `${id}@example.test`, authVersion: 0, sid: await sessions.create(id, 'synthetic-device') });
    const [tokenA, tokenB, tokenC] = await Promise.all([token(a), token(b), token(c)]);
    const app = express(); app.use(express.json());
    const spec = YAML.load(path.resolve(__dirname, '../../api/swagger/swagger.yaml'));
    await new Promise(resolve => swaggerTools.initializeMiddleware(spec, middleware => {
      app.use(middleware.swaggerMetadata()); app.use(middleware.swaggerSecurity({ Bearer: async (req, _, value, cb) => {
        try { if (await authenticate(req, value)) return cb(); const error = new Error('Unauthorized'); error.statusCode = 401; return cb(error); } catch (_) { const error = new Error('Unavailable'); error.statusCode = 503; return cb(error); }
      } })); app.use(middleware.swaggerValidator()); app.use(middleware.swaggerRouter({ controllers: path.resolve(__dirname, '../fixtures/careTrialControllers'), useStubs: false }));
      app.use((error, req, res, next) => res.status(error.statusCode || error.status || 500).json({ code: error.code || 'HTTP_ERROR' })); resolve();
    }));
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
    const claim = async (tokenValue, familyId) => { const response = await fetch(base + '/care/trial-claims', { method: 'POST', headers: { Authorization: `Bearer ${tokenValue}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ familyId }) }); return { status: response.status, body: await response.json(), headers: response.headers }; };
    assert.equal((await claim('', 'family-a')).status, 401);
    const first = await claim(tokenA, 'family-a'); assert.equal(first.status, 200); const replay = await claim(tokenA, 'family-a'); assert.equal(replay.status, 200); assert.deepEqual(replay.body, first.body);
    assert.equal((await claim(tokenA, 'family-b')).body.code, 'TRIAL_ACCOUNT_ALREADY_CLAIMED');
    assert.equal((await claim(tokenB, 'family-a')).body.code, 'FAMILY_OWNER_REQUIRED');
    // RateLimiterMongo permits exactly `points` successful consumes. With a
    // three-point account window the fourth request is the first 429.
    assert.equal((await claim(tokenC, 'family-c')).status, 200); assert.equal((await claim(tokenC, 'family-c')).status, 200); assert.equal((await claim(tokenC, 'family-c')).status, 200); const limited = await claim(tokenC, 'family-c'); assert.equal(limited.status, 429); assert(limited.headers.get('retry-after'));
    const { createRuntime: createBudget } = require('../../api/helpers/careBudgetRuntime'); const pending = createBudget();
    await pending.provision('pending-funding', { owner: a, kind: 'family', familyId: 'family-a', weeklyLimit: 0, startsAt: 1000, expiresAt: 9000, trialClaimId: 'pending-claim' });
    await pending.addPack('pending-funding', { id: 'pending-pack', type: 'trial', amount: 1, startsAt: 1000, expiresAt: 9000 });
    await assert.rejects(pending.reserve('pending-funding', { actor: a, profileId: 'synthetic-profile', requestId: 'pending-use', units: 1, fingerprint: 'a'.repeat(64) }), error => error.code === 'TRIAL_PENDING_ACTIVATION');
    console.log(JSON.stringify({ result: 'passed', careTrialHttpMongo: true, scenarios: ['auth-policy-runtime', 'account-family-limit-pending-gate'], syntheticOnly: true, productionDatabaseTouched: false }));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (mongoose.connection.name !== databaseName) throw new Error('Cleanup database guard failed'); await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
}
main().catch(async error => { console.error(error.name, error.code || error.message); await mongoose.disconnect(); process.exitCode = 1; });

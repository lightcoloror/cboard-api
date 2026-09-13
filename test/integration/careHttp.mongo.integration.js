'use strict';
// Standalone synthetic acceptance; never imports db.js or seeds a production account.
const assert = require('assert').strict;
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const mongoose = require('mongoose');
const express = require('express');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');
const root = path.resolve(__dirname, '../..');
async function main() {
  const nextPhase = process.argv.includes('--next');
  const uri = process.env.CARE_TEST_MONGO_URI;
  if (!uri || !/^mongodb:\/\/[^/]+\/care_test_[a-f0-9]+$/.test(uri)) throw new Error('Explicit isolated care_test database required');
  const databaseName = uri.split('/').pop();
  const mediaRoot = path.join(process.env.TEST_TMP_ROOT || require('os').tmpdir(), databaseName);
  process.env.CARE_COLLABORATION_ENABLED = 'true';
  process.env.CARE_NEXT_ENABLED = nextPhase ? 'true' : 'false';
  if (nextPhase) process.env.CARE_AI_PRICE_POLICY = JSON.stringify({ generateCommunicationSentences: { reservationUnits: 5, fixedUnits: 1, tokensPerUnit: 10 } });
  process.env.CARE_ENCRYPTION_ACTIVE_KEY = 'test';
  process.env.CARE_ENCRYPTION_KEYS = JSON.stringify({ test: crypto.randomBytes(32).toString('hex') });
  process.env.CARE_MEDIA_ROOT = mediaRoot;
  await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  const sessions = require('../../api/helpers/deviceSessions');
  const auth = require('../../api/helpers/auth');
  const authenticate = require('../../api/helpers/authenticateBearer').createBearerAuthenticator({ auth, sessions,
    users: { getById: async id => mongoose.connection.collection('test_users').findOne({ id }) } });
  const api = express(); api.use(express.json({ limit: '10mb' }));
  const spec = YAML.load(path.join(root, 'api/swagger/swagger.yaml'));
  await new Promise(resolve => swaggerTools.initializeMiddleware(spec, middleware => {
    api.use(middleware.swaggerMetadata());
    api.use(middleware.swaggerSecurity({ Bearer: async (req, _, token, cb) => {
      try { if (await authenticate(req, token)) return cb();
        const e = new Error('Unauthorized'); e.statusCode = 401; cb(e);
      } catch (_) { const e = new Error('Unavailable'); e.statusCode = 503; cb(e); }
    } }));
    if (nextPhase) {
      api.use(require('../../api/helpers/careAiMetering').createCareAiMetering());
      const aiPath = Object.keys(spec.paths).find(p => spec.paths[p].post && spec.paths[p].post.operationId === 'generateCommunicationSentences');
      api.post(aiPath, async (req, res) => {
        await req.careUsage.observe({ totalTokens: 20 });
        res.status(200).json({ synthetic: true, sentences: ['合成一句', '合成二句', '合成三句'] });
      });
    }
    api.use(middleware.swaggerRouter({ controllers: path.join(root, 'api/controllers'), ignoreMissingHandlers: true }));
    api.use((error, req, res, next) => res.status(error.statusCode || 500).json({ code: 'TEST_HTTP_ERROR' }));
    resolve();
  }));
  const server = api.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (token, url, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const tokens = [];
  try {
    const a = new mongoose.Types.ObjectId().toString(), b = new mongoose.Types.ObjectId().toString();
    await mongoose.connection.collection('test_users').insertMany([{ id: a, email: 'a@example.test', authVersion: 0 }, { id: b, email: 'b@example.test', authVersion: 0 }]);
    for (const user of [a, a, b]) { const sid = await sessions.create(user, 'synthetic-device');
      tokens.push(auth.issueToken({ id: user, email: `${user}@example.test`, authVersion: 0, sid })); }
    assert.equal((await request(auth.issueToken({ id: a, email: 'a@example.test' }), '/care/profiles')).status, 401);
    const preview = await request(tokens[0], '/care/migration-preview');
    assert.equal(preview.status, 200); assert.equal(preview.body.originalDataModified, false);
    const family = await request(tokens[0], '/care/families', 'POST', { name: '合成家庭' }); assert.equal(family.status, 200);
    if (nextPhase) {
      const subscriptions = require('../../api/helpers/careSubscription').createCareSubscription({ store: require('../../api/helpers/careRuntime').store, encryption: require('../../api/helpers/careCrypto').fromEnvironment() });
      await subscriptions.activate({ familyId: family.body.id, payerId: a, receiptId: 'synthetic-subscription', startsAt: Date.now() - 1000, expiresAt: Date.now() + 86400000 });
    }
    const profile = await request(tokens[0], '/care/profiles', 'POST', { familyId: family.body.id, name: '合成患者' }); assert.equal(profile.status, 200);
    const endpoint = `/care/profiles/${profile.body.id}`;
    assert.equal((await request(tokens[2], endpoint)).status, 403);
    const invitation = await request(tokens[0], endpoint + '/commands', 'POST', { action: 'invite', operationId: 'invite-one', permissions: ['read', 'library.edit'] });
    assert.equal(invitation.status, 200);
    assert.equal((await request(tokens[2], '/care/invitations/accept', 'POST', { token: invitation.body.token })).status, 200);
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const asset = { mediaId: 'photo', data: image.toString('base64'), sha256: crypto.createHash('sha256').update(image).digest('hex'), type: 'image/png' };
    assert.equal((await request(tokens[0], endpoint + '/media', 'POST', asset)).status, 200);
    const op = { action: 'put', kind: 'tile', resourceId: 'water', operationId: 'water-one', baseVersion: 0, value: { label: '喝水', mediaId: 'photo' } };
    const concurrent = await Promise.all([request(tokens[2], endpoint + '/commands', 'POST', op), request(tokens[2], endpoint + '/commands', 'POST', op)]);
    assert(concurrent.every(r => r.status === 200)); assert.deepEqual(concurrent[0].body, concurrent[1].body);
    assert.equal((await request(tokens[1], endpoint)).body.resources[0].value.label, '喝水');
    assert.equal((await request(tokens[2], endpoint + '/media/photo')).body.data, asset.data);
    if (nextPhase) {
      assert.equal((await request(tokens[2], '/care/context', 'PUT', { profileId: profile.body.id })).status, 200);
      assert.equal((await request(tokens[2], '/care/context')).body.selectedProfileId, profile.body.id);
      assert.equal((await request(tokens[2], endpoint + '/commands', 'POST', { action: 'relationship', operationId: 'patient-role', value: { role: 'patient' } })).body.relationship.defaultMode, 'expression');
      assert.equal((await request(tokens[0], endpoint + '/entitlements')).body.state, 'active');
      const favorite = { resourceId: 'own-favorite', operationId: 'favorite-one', action: 'put', baseVersion: 0, value: { sentence: '合成个人收藏', mediaId: 'photo' } };
      assert.equal((await request(tokens[2], endpoint + '/favorites', 'POST', favorite)).status, 200);
      assert.equal((await request(tokens[0], endpoint + '/favorites')).body.items.length, 0);
      assert(!(await request(tokens[0], endpoint)).body.resources.some(r => r.id === 'own-favorite'));
      assert.equal((await request(tokens[2], endpoint + '/commands', 'POST', { action: 'shareFavorite', operationId: 'share-one', sourceId: 'own-favorite', sourceVersion: 1, resourceId: 'shared-favorite' })).status, 200);
      assert.equal((await request(tokens[0], endpoint + '/commands', 'POST', { action: 'put', operationId: 'shared-edit', kind: 'favorite', resourceId: 'shared-favorite', baseVersion: 1, value: { sentence: '合成家庭修改' } })).status, 200);
      assert.equal((await request(tokens[2], endpoint + '/favorites')).body.items[0].value.sentence, '合成个人收藏');
      assert.equal((await request(tokens[0], endpoint + '/favorite-original', 'POST', { ...favorite, operationId: 'original-edit', sharedId: 'shared-favorite', sharedVersion: 2, baseVersion: 1, value: { sentence: '合成原收藏修改' } })).status, 200);
      const budget = require('../../api/helpers/careBudgetRuntime').createRuntime();
      await budget.provision('synthetic-funding', { owner: a, kind: 'family', familyId: family.body.id, weeklyLimit: 100, startsAt: Date.now() - 1000, expiresAt: Date.now() + 86400000 });
      assert.equal((await request(tokens[0], '/care/funding/synthetic-funding/delegation', 'POST', { member: b, limit: 10, profileIds: [profile.body.id] })).status, 200);
      assert.equal((await request(tokens[2], `/care/funding?profileId=${profile.body.id}`)).body.items.length, 1);
      const aiPath = Object.keys(spec.paths).find(p => spec.paths[p].post && spec.paths[p].post.operationId === 'generateCommunicationSentences');
      const headers = { 'x-care-funding-id': 'synthetic-funding', 'x-care-profile-id': profile.body.id, 'idempotency-key': 'synthetic-ai-one' };
      assert.equal((await request(tokens[2], aiPath, 'POST', { labels: ['合成'] })).body.code, 'EXPLICIT_FUNDING_REQUIRED');
      assert.equal((await request(tokens[2], aiPath, 'POST', { labels: ['合成'] }, headers)).status, 200);
      assert.equal((await request(tokens[2], aiPath, 'POST', { labels: ['合成'] }, headers)).status, 409);
      for (let attempt = 0; attempt < 30; attempt++) {
        if ((await budget.snapshot('synthetic-funding', b, profile.body.id)).weeklyUsed === 2) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal((await budget.snapshot('synthetic-funding', b, profile.body.id)).weeklyUsed, 2);
      // Explicit deletion tests restore only encrypted synthetic collections.
      for (const name of ['careaccounts', 'carefundings', 'carefamilies']) {
        const backup = await mongoose.connection.collection(name).find({}).toArray();
        assert(!JSON.stringify(backup).includes('合成个人收藏'));
        await mongoose.connection.collection(name).deleteMany({});
        if (backup.length) await mongoose.connection.collection(name).insertMany(backup);
      }
      assert.equal((await budget.snapshot('synthetic-funding', b, profile.body.id)).weeklyUsed, 2);
      assert.equal((await request(tokens[2], endpoint + '/favorites')).body.items[0].value.sentence, '合成原收藏修改');
    }
    // Copy encrypted Mongo documents and encrypted blobs, restore into the same isolated database.
    const backup = await mongoose.connection.collection('careprofiles').find({}).toArray();
    assert(!JSON.stringify(backup).includes('喝水'));
    const files = await fs.readdir(mediaRoot); const bytes = await fs.readFile(path.join(mediaRoot, files[0]));
    assert(!bytes.toString().includes(asset.data));
    await mongoose.connection.collection('careprofiles').deleteMany({});
    await mongoose.connection.collection('careprofiles').insertMany(backup);
    await fs.writeFile(path.join(mediaRoot, files[0]), bytes);
    assert.equal((await request(tokens[2], endpoint + '/media/photo')).body.data, asset.data);
    assert.equal((await request(tokens[0], endpoint + '/commands', 'POST', { action: 'grant', operationId: 'revoke-one', member: b, permissions: [] })).status, 200);
    assert.equal((await request(tokens[2], endpoint + '/media/photo')).status, 403);
    const list = await request(tokens[0], '/user/sessions'); assert.equal(list.body.items.length, 2);
    assert.equal((await request(tokens[0], '/user/sessions', 'POST', { id: auth.getTokenData(tokens[0]).sid })).status, 200);
    assert.equal((await request(tokens[0], endpoint)).status, 401);
    assert.equal((await request(tokens[1], endpoint)).status, 200);
    await request(tokens[1], '/user/sessions', 'POST', { all: true });
    assert.equal((await request(tokens[1], endpoint)).status, 401);
    console.log(JSON.stringify({ result: 'passed', httpMongo: true, encryptedFileMedia: true, restore: true,
      nextPhase, syntheticAiMetering: nextPhase, externalAiProviderExecuted: false,
      syntheticOnly: true, productionDatabaseTouched: false }));
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (mongoose.connection.name !== databaseName) throw new Error('Cleanup database guard failed');
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
    if (path.basename(mediaRoot) !== databaseName || !databaseName.startsWith('care_test_')) throw new Error('Cleanup path guard failed');
    await fs.rm(mediaRoot, { recursive: true, force: true });
  }
}
main().catch(async error => {
  console.error(error.name, error.code || error.message);
  console.error(String(error.stack || '').split('\n').filter(line => /^\s+at /.test(line)).join('\n'));
  await mongoose.disconnect();
  process.exitCode = 1;
});

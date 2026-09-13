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
  const uri = process.env.CARE_TEST_MONGO_URI;
  if (!uri || !/^mongodb:\/\/[^/]+\/care_test_[a-f0-9]+$/.test(uri)) throw new Error('Explicit isolated care_test database required');
  const databaseName = uri.split('/').pop();
  const mediaRoot = path.join(process.env.TEST_TMP_ROOT || require('os').tmpdir(), databaseName);
  process.env.CARE_COLLABORATION_ENABLED = 'true';
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
    api.use(middleware.swaggerRouter({ controllers: path.join(root, 'api/controllers'), ignoreMissingHandlers: true }));
    api.use((error, req, res, next) => res.status(error.statusCode || 500).json({ code: 'TEST_HTTP_ERROR' }));
    resolve();
  }));
  const server = api.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (token, url, method = 'GET', body) => {
    const response = await fetch(base + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
  await mongoose.disconnect();
  process.exitCode = 1;
});

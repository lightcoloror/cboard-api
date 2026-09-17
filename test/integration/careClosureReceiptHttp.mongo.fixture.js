'use strict';

const assert = require('assert').strict;
const path = require('path');
const express = require('express');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');

const root = path.resolve(__dirname, '../..');

module.exports = async function careClosureReceiptHttpMongoFixture({
  mongoose,
  passed,
  encryption,
  fileMedia,
  quotaService
}) {
  const previousCollaboration = process.env.CARE_COLLABORATION_ENABLED;
  const previousLifecycle = process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
  const previousConfirmation = process.env.CARE_CLOSURE_CONFIRMATION_ENABLED;
  process.env.CARE_COLLABORATION_ENABLED = 'true';
  process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';

  let server;
  try {
    const sessions = require('../../api/helpers/deviceSessions');
    const auth = require('../../api/helpers/auth');
    const users = mongoose.connection.collection('users');
    const userById = async id => {
      const user = await users.findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
      if (!user) return null;
      return { ...user, id: String(user._id), email: user.email };
    };
    const authenticate = require('../../api/helpers/authenticateBearer')
      .createBearerAuthenticator({ auth, sessions, users: { getById: userById } });
    const spec = YAML.load(path.join(root, 'api/swagger/swagger.yaml'));
    const api = express();
    api.use(express.json());
    await new Promise((resolve, reject) => swaggerTools.initializeMiddleware(spec, middleware => {
      try {
        api.use(middleware.swaggerMetadata());
        api.use(middleware.swaggerSecurity({ Bearer: async (req, _, token, callback) => {
          try {
            if (await authenticate(req, token)) return callback();
            const error = new Error('Unauthorized'); error.statusCode = 401; return callback(error);
          } catch (_) {
            const error = new Error('Unavailable'); error.statusCode = 503; return callback(error);
          }
        } }));
        // Keep the controller's uniform capability validation observable for
        // malformed probes; the integration still uses Swagger metadata/router.
        const receiptController = require('../../api/controllers/careClosureReceipt');
        api.use(middleware.swaggerRouter({ controllers: {
          careClosureReceipt_prepareClosureReceipt: receiptController.prepareClosureReceipt,
          careClosureReceipt_inspectClosureReceipt: receiptController.inspectClosureReceipt,
          careClosureConfirm_confirmClosure: require('../../api/controllers/careClosureConfirm').confirmClosure,
          account_removeAccount: require('../../api/controllers/account').removeAccount,
          careClosure_previewClosure: require('../../api/controllers/careClosure').previewClosure
        }, ignoreMissingHandlers: true }));
        api.use((error, req, res, next) => res.status(error.statusCode || error.status || 500)
          .json({ code: 'TEST_HTTP_ERROR' }));
        resolve();
      } catch (error) { reject(error); }
    }));
    server = api.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (token, url, method = 'GET', body) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const result = await fetch(base + url, {
        method, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return { status: result.status, headers: result.headers, body: await result.json() };
    };

    const ownerA = new mongoose.Types.ObjectId();
    const ownerB = new mongoose.Types.ObjectId();
    await users.insertMany([
      { _id: ownerA, name: 'Synthetic receipt A', email: 'receipt-a@example.test', password: 'synthetic', authVersion: 0 },
      { _id: ownerB, name: 'Synthetic receipt B', email: 'receipt-b@example.test', password: 'synthetic', authVersion: 0 }
    ]);
    const ownerAId = String(ownerA);
    const ownerBId = String(ownerB);
    const tokenFor = async (id, email) => {
      const sid = await sessions.create(id, 'synthetic-receipt-device');
      return auth.issueToken({ id, email, authVersion: 0, sid });
    };
    const tokenA = await tokenFor(ownerAId, 'receipt-a@example.test');
    const tokenB = await tokenFor(ownerBId, 'receipt-b@example.test');
    const legacyDeletion = await request(tokenB, `/account/${ownerBId}`, 'DELETE');
    assert.equal(legacyDeletion.status, 409);
    assert.equal(legacyDeletion.body.error.code, 'CLOSURE_CONFIRMATION_REQUIRED');
    assert(await users.findOne({ _id: ownerB }));

    const anonymous = await request(null, '/care/account/closure-receipt', 'POST', {});
    assert.equal(anonymous.status, 401);
    passed.push('closure-receipt-http-anonymous-prepare-401');

    const preparedResponse = await request(tokenA, '/care/account/closure-receipt', 'POST', {
      owner: ownerBId
    });
    assert.equal(preparedResponse.status, 201);
    assert.equal(preparedResponse.headers.get('cache-control'), 'no-store');
    assert.equal(preparedResponse.body.receiptId, ownerAId);
    assert.match(preparedResponse.body.secret, /^[a-f0-9]{64}$/);
    const secretA = preparedResponse.body.secret;
    passed.push('closure-receipt-http-authenticated-prepare-no-store');

    const preparedStatus = await request(null, '/care/account/closure-status', 'POST', {
      receiptId: ownerAId, secret: secretA
    });
    assert.equal(preparedStatus.status, 200);
    assert.equal(preparedStatus.headers.get('cache-control'), 'no-store');
    assert.deepEqual(preparedStatus.body.status, 'prepared');
    assert.equal(preparedStatus.body.owner, undefined);

    const wrongSecret = await request(null, '/care/account/closure-status', 'POST', {
      receiptId: ownerAId, secret: 'b'.repeat(64)
    });
    assert.equal(wrongSecret.status, 404);
    const extraField = await request(null, '/care/account/closure-status', 'POST', {
      receiptId: ownerAId, secret: secretA, forged: ownerBId
    });
    assert.equal(extraField.status, 404);
    const queryCredentials = await request(null,
      `/care/account/closure-status?receiptId=${ownerAId}&secret=${secretA}`, 'POST', {});
    assert.equal(queryCredentials.status, 404);
    passed.push('closure-receipt-http-status-no-bearer-and-strict-body');

    const familyId = `family-http-${ownerAId}`;
    const profileId = `profile-http-${ownerAId}`;
    const families = mongoose.connection.collection('carefamilies');
    const profiles = mongoose.connection.collection('careprofiles');
    await families.insertOne({ _id: familyId, owner: ownerAId, rev: 0, sealed: encryption.seal({}, `family:${familyId}`) });
    await profiles.insertOne({ _id: profileId, familyId, owner: ownerAId, members: [ownerAId], rev: 0,
      sealed: encryption.seal({ grants: { [ownerAId]: ['read'] } }, `profile:${profileId}`) });
    const confirmation = { familyIds: [familyId], secret: secretA, confirmCloudDeletion: true };
    process.env.CARE_CLOSURE_CONFIRMATION_ENABLED = 'false';
    assert.equal((await request(tokenA, '/care/account/closure-confirm', 'POST', confirmation)).status, 503);
    process.env.CARE_CLOSURE_CONFIRMATION_ENABLED = 'true';
    assert.equal((await request(null, '/care/account/closure-confirm', 'POST', confirmation)).status, 401);
    assert.equal((await request(tokenA, '/care/account/closure-confirm', 'POST', { ...confirmation, confirmCloudDeletion: false })).status, 400);
    assert.equal((await request(tokenA, '/care/account/closure-confirm', 'POST', { ...confirmation, familyIds: [] })).status, 409);
    assert.equal((await request(tokenB, '/care/account/closure-confirm', 'POST', { ...confirmation, familyIds: [] })).status, 404);
    const preview = await request(tokenA, '/care/account/closure-preview');
    assert.deepEqual(preview.body.familyIds, [familyId]);
    await profiles.updateOne({ _id: profileId }, { $addToSet: { members: ownerBId } });
    assert.equal((await request(tokenA, '/care/account/closure-confirm', 'POST', confirmation)).status, 409);
    assert.equal((await families.findOne({ _id: familyId })).closure, undefined);
    assert.equal((await request(null, '/care/account/closure-status', 'POST', { receiptId: ownerAId, secret: secretA })).body.status, 'prepared');
    // Synthetic member leaves; the next HTTP confirmation re-evaluates current scope.
    await profiles.updateOne({ _id: profileId }, { $set: { members: [ownerAId] } });
    const confirmedResponse = await request(tokenA, '/care/account/closure-confirm', 'POST', confirmation);
    assert.equal(confirmedResponse.status, 202);
    assert.equal(confirmedResponse.headers.get('cache-control'), 'no-store');
    assert.equal(confirmedResponse.body.accountDeleted, false);
    assert.equal(confirmedResponse.body.secret, undefined);
    const confirmed = confirmedResponse.body;
    passed.push('closure-confirm-http-explicit-self-only-revalidates-family-and-enqueues-202');
    const confirmedStatus = await request(null, '/care/account/closure-status', 'POST', {
      receiptId: ownerAId, secret: secretA
    });
    assert.equal(confirmedStatus.status, 200);
    assert.equal(confirmedStatus.body.status, 'confirmed');
    assert.equal(confirmedStatus.body.operationId, confirmed.operationId);
    const oldBearerPreview = await request(tokenA, '/care/account/closure-preview');
    assert.equal(oldBearerPreview.status, 401);
    const crossOwner = await request(null, '/care/account/closure-status', 'POST', {
      receiptId: ownerAId, secret: 'c'.repeat(64)
    });
    assert.equal(crossOwner.status, 404);
    // The second synthetic user must remain unaffected by the first closure.
    assert.equal((await request(tokenB, '/care/account/closure-status', 'POST', {
      receiptId: ownerAId, secret: 'd'.repeat(64)
    })).status, 404);
    passed.push('closure-receipt-http-confirmed-status-works-after-bearer-revocation');
    const { createCareClosureRuntime } = require('../../api/helpers/careClosureRuntime');
    const runtime = createCareClosureRuntime({ connection: mongoose.connection, encryption, media: fileMedia,
      revokeSessions: owner => sessions.revoke(owner),
      cleanup: args => require('../../api/controllers/account').cleanupAccountData({ ...args, quotaService })
    });
    let completed;
    for (let attempt = 0; attempt < 5; attempt++) {
      completed = await runtime.runner.run(ownerAId, confirmed.operationId);
      if (completed.accountDeleted) break;
    }
    assert.equal(completed.accountDeleted, true);
    const completedStatus = await request(null, '/care/account/closure-status', 'POST', { receiptId: ownerAId, secret: secretA });
    assert.equal(completedStatus.body.accountDeleted, true);
    assert.equal(completedStatus.body.cleanupStatus, 'complete');
    assert.equal(await users.findOne({ _id: ownerA }), null);
    assert(await users.findOne({ _id: ownerB }));
    assert.equal((await request(tokenA, '/care/account/closure-confirm', 'POST', confirmation)).status, 401);
    passed.push('closure-http-confirm-to-runtime-cleanup-and-http-complete-preserves-other-user');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (previousCollaboration === undefined) delete process.env.CARE_COLLABORATION_ENABLED;
    else process.env.CARE_COLLABORATION_ENABLED = previousCollaboration;
    if (previousLifecycle === undefined) delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    else process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = previousLifecycle;
    if (previousConfirmation === undefined) delete process.env.CARE_CLOSURE_CONFIRMATION_ENABLED;
    else process.env.CARE_CLOSURE_CONFIRMATION_ENABLED = previousConfirmation;
  }
};

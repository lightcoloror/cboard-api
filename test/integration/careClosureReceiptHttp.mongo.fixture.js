'use strict';

const assert = require('assert').strict;
const path = require('path');
const express = require('express');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');
const { createCareClosureCoordinator } = require('../../api/helpers/careClosureCoordinator');
const { createCareClosureReceipt } = require('../../api/helpers/careClosureReceipt');

const root = path.resolve(__dirname, '../..');

module.exports = async function careClosureReceiptHttpMongoFixture({
  mongoose,
  passed,
  encryption
}) {
  const previousCollaboration = process.env.CARE_COLLABORATION_ENABLED;
  const previousLifecycle = process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
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

    const receiptStore = createCareClosureReceipt({ connection: mongoose.connection });
    const coordinator = createCareClosureCoordinator({ connection: mongoose.connection, encryption, receipt: receiptStore });
    const confirmed = await coordinator.begin(ownerAId, [], secretA);
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
    // Keep the second authenticated synthetic user and account available for
    // the host fixture; no User or private data is deleted here.
    assert.equal((await request(tokenB, '/care/account/closure-status', 'POST', {
      receiptId: ownerAId, secret: 'd'.repeat(64)
    })).status, 404);
    passed.push('closure-receipt-http-confirmed-status-works-after-bearer-revocation');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (previousCollaboration === undefined) delete process.env.CARE_COLLABORATION_ENABLED;
    else process.env.CARE_COLLABORATION_ENABLED = previousCollaboration;
    if (previousLifecycle === undefined) delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    else process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = previousLifecycle;
  }
};

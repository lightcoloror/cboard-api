'use strict';

// Synthetic-only context ordering fixture. It requires an explicitly isolated
// care_test_<hex> database and never imports db.js or production credentials.
const assert = require('assert').strict;
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');

const root = path.resolve(__dirname, '../..');
const serve = process.argv.includes('--serve');
const runId = process.env.CARE_TEST_RUN_ID;
const uri = process.env.CARE_TEST_MONGO_URI;
const port = Number(process.env.CARE_TEST_PORT || process.env.PORT || (serve ? 18765 : 0));
const ttlSeconds = Number(process.env.TTL_SECONDS || 900);
const readyFile = process.env.READY_FILE;
const privateFile = process.env.PRIVATE_FILE;
if (!/^[a-f0-9]{8,64}$/.test(runId || '')) throw new Error('Explicit hexadecimal CARE_TEST_RUN_ID required');
if (!uri || !new RegExp(`^mongodb://[^/]+/care_test_${runId}$`).test(uri)) throw new Error('Exact isolated care_test_<runId> URI required');
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 3600) throw new Error('Invalid TTL_SECONDS');
if (serve && (!readyFile || !privateFile)) throw new Error('READY_FILE and PRIVATE_FILE required in --serve mode');

const writePrivateJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); } finally { fs.closeSync(fd); }
  fs.chmodSync(file, 0o600);
};
const writePublicJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
};

async function main() {
  process.env.CARE_COLLABORATION_ENABLED = 'true';
  process.env.CARE_NEXT_ENABLED = 'true';
  process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED || 'true';
  process.env.CARE_ENCRYPTION_ACTIVE_KEY = 'context-ordering';
  process.env.CARE_ENCRYPTION_KEYS = JSON.stringify({ 'context-ordering': crypto.randomBytes(32).toString('hex') });
  process.env.API_SESSION_SECRET = process.env.API_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

  await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  const databaseName = mongoose.connection.name;
  assert.equal(databaseName, `care_test_${runId}`);

  const User = require('../../api/models/User');
  require('../../api/models/Board');
  const auth = require('../../api/helpers/auth');
  const sessions = require('../../api/helpers/deviceSessions');
  const runtime = require('../../api/helpers/careRuntime');
  const encryption = require('../../api/helpers/careCrypto').fromEnvironment();
  const userController = require('../../api/controllers/user');
  const careController = require('../../api/controllers/care');
  const authenticate = require('../../api/helpers/authenticateBearer').createBearerAuthenticator({ auth, sessions, users: User });
  const spec = YAML.load(path.join(root, 'api/swagger/swagger.yaml'));
  const api = express();
  api.use(express.json({ limit: '1mb' }));
  api.use(session({ secret: process.env.API_SESSION_SECRET, resave: false, saveUninitialized: false }));

  const controlSecret = crypto.randomBytes(32).toString('hex');
  const events = [];
  let currentGate = null;
  let mainAccountId = null;
  let ownedAProfileId = null;
  const safeEvent = (type, detail = {}) => events.push({ sequence: events.length + 1, type, ...detail });
  const authorizeControl = req => {
    const supplied = Buffer.from(String(req.get('x-control-secret') || ''));
    const expected = Buffer.from(controlSecret);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  };
  const arm = profileId => {
    assert(!currentGate, 'A gate already armed');
    assert(mainAccountId && ownedAProfileId && profileId === ownedAProfileId, 'Only the main account owned A profile can be armed');
    let enterResolve, releaseResolve;
    const gate = {
      profileId,
      used: false,
      released: false,
      entered: new Promise(resolve => { enterResolve = resolve; }),
      releaseSignal: new Promise(resolve => { releaseResolve = resolve; }),
      enterResolve,
      releaseResolve
    };
    currentGate = gate;
    safeEvent('gate-armed', { profileId });
    return gate;
  };
  const release = (outcome = 'original') => {
    assert(['original', '503'].includes(outcome), 'Unsupported gate release outcome');
    const gate = currentGate;
    assert(gate && !gate.released, 'No current unreleased gate');
    gate.released = true;
    gate.releaseResolve(outcome);
    safeEvent('gate-released', { profileId: gate.profileId, outcome });
  };
  const gateBeforePersistence = async (accountId, context) => {
    const gate = currentGate;
    if (!gate || gate.used || String(accountId) !== mainAccountId || context.mode !== 'select-profile' || context.profileId !== gate.profileId) return;
    gate.used = true;
    safeEvent('gate-entered', { profileId: context.profileId });
    gate.enterResolve();
    try {
      const outcome = await gate.releaseSignal;
      if (outcome === '503') throw Object.assign(new Error('Synthetic account persistence failure'), {
        status: 503, code: 'SYNTHETIC_ACCOUNT_WRITE_FAILED'
      });
      return gate;
    } catch (error) {
      error.fixtureGate = gate;
      throw error;
    }
  };
  const completeGate = gate => {
    if (!gate) return;
    if (currentGate === gate) currentGate = null;
    safeEvent('gate-completed', { profileId: gate.profileId });
  };
  const originalCasAccount = runtime.store.casAccount;
  const originalCreateAccount = runtime.store.createAccount;
  runtime.store.casAccount = async (id, rev, value, context = {}) => {
    let gate;
    try {
      gate = await gateBeforePersistence(id, context);
      const result = await originalCasAccount(id, rev, value, context);
      safeEvent('account-cas', { account: crypto.createHash('sha256').update(String(id)).digest('hex'), profileId: context.profileId || null, rev, result });
      return result;
    } catch (error) {
      gate = gate || error.fixtureGate;
      throw error;
    } finally { completeGate(gate); }
  };
  runtime.store.createAccount = async (value, context = {}) => {
    let gate;
    try {
      gate = await gateBeforePersistence(value._id, context);
      const result = await originalCreateAccount(value, context);
      safeEvent('account-create', { account: crypto.createHash('sha256').update(String(value._id)).digest('hex'), profileId: context.profileId || null, result });
      return result;
    } catch (error) {
      gate = gate || error.fixtureGate;
      throw error;
    } finally { completeGate(gate); }
  };

  api.post('/__fixture/control/:action', (req, res) => {
    if (!authorizeControl(req)) return res.status(404).json({ code: 'NOT_FOUND' });
    try {
      if (req.params.action === 'arm') { arm(req.body && req.body.profileId); return res.json({ status: 'armed' }); }
      if (req.params.action === 'release') { release(req.body && req.body.outcome || 'original'); return res.json({ status: 'released' }); }
      if (req.params.action === 'status') return res.json({ status: currentGate ? currentGate.used ? currentGate.released ? 'released' : 'entered' : 'armed' : 'idle', events });
      return res.status(404).json({ code: 'NOT_FOUND' });
    } catch (_) { return res.status(409).json({ code: 'CONTROL_STATE_CONFLICT' }); }
  });

  await new Promise((resolve, reject) => swaggerTools.initializeMiddleware(spec, middleware => {
    try {
      api.use(middleware.swaggerMetadata());
      api.use(middleware.swaggerSecurity({ Bearer: async (req, _, token, callback) => {
        try {
          if (await authenticate(req, token)) return callback();
          const error = new Error('Unauthorized'); error.statusCode = 401; return callback(error);
        } catch (_) { const error = new Error('Unavailable'); error.statusCode = 503; return callback(error); }
      } }));
      api.use(middleware.swaggerRouter({ controllers: Object.fromEntries([
        ...Object.entries(userController).map(([name, handler]) => [`user_${name}`, handler]),
        ...Object.entries(careController).map(([name, handler]) => [`care_${name}`, handler])
      ]), ignoreMissingHandlers: true }));
      api.use((error, req, res, next) => res.status(error.statusCode || error.status || 500).json({ code: 'TEST_HTTP_ERROR' }));
      resolve();
    } catch (error) { reject(error); }
  }));

  let server;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (currentGate && !currentGate.released) release();
    runtime.store.casAccount = originalCasAccount;
    runtime.store.createAccount = originalCreateAccount;
    if (server) await new Promise(resolve => server.close(resolve));
    if (mongoose.connection.name !== `care_test_${runId}`) throw new Error('Cleanup database guard failed');
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  };

  try {
    server = api.listen(port, serve ? '0.0.0.0' : '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const actualPort = server.address().port;
    const base = `http://127.0.0.1:${actualPort}`;
    const cookies = new Map();
    const http = async (client, route, method = 'GET', body, token) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (cookies.has(client)) headers.Cookie = cookies.get(client);
      const response = await fetch(base + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const cookie = response.headers.get('set-cookie');
      if (cookie) cookies.set(client, cookie.split(';')[0]);
      let data = null; try { data = await response.json(); } catch (_) {}
      return { status: response.status, body: data };
    };

    const suffix = runId.slice(0, 16);
    const credentials = [0, 1].map(index => ({
      email: `context-order-${suffix}-${index}@example.test`,
      password: `Synthetic-${crypto.randomBytes(18).toString('base64url')}`
    }));
    const users = [];
    for (let index = 0; index < credentials.length; index++) {
      const user = await User.create({ name: `Synthetic context ${index}`, email: credentials[index].email,
        password: await bcrypt.hash(credentials[index].password, 10), role: 'user', authVersion: 0,
        location: { country: 'ZZ' }, locale: 'zh-CN', isFirstLogin: false });
      users.push(String(user._id));
    }
    const login = async (client, index) => {
      const result = await http(client, '/user/login', 'POST', credentials[index]);
      assert.equal(result.status, 200);
      assert.equal(typeof result.body.authToken, 'string');
      safeEvent('login', { account: index });
      return result.body.authToken;
    };
    const tokenA = await login('owner-a-initial', 0);
    const tokenOther = await login('owner-other', 1);
    const care = (client, token, route, method = 'GET', body) => http(client, route, method, body, token);
    const familyA = (await care('owner-a-initial', tokenA, '/care/families', 'POST', { name: '合成顺序家庭甲' })).body;
    const familyOther = (await care('owner-other', tokenOther, '/care/families', 'POST', { name: '合成顺序家庭乙' })).body;
    const subscriptions = require('../../api/helpers/careSubscription').createCareSubscription({ store: runtime.store, encryption });
    for (const [family, payer] of [[familyA, users[0]], [familyOther, users[1]]]) {
      await subscriptions.activate({ familyId: family.id, payerId: payer, receiptId: `synthetic-${family.id}`,
        startsAt: Date.now() - 1000, expiresAt: Date.now() + 3600000 });
    }
    const profileA = (await care('owner-a-initial', tokenA, '/care/profiles', 'POST', { familyId: familyA.id, name: '合成档案甲' })).body;
    const profileB = (await care('owner-a-initial', tokenA, '/care/profiles', 'POST', { familyId: familyA.id, name: '合成档案乙' })).body;
    const profileOther = (await care('owner-other', tokenOther, '/care/profiles', 'POST', { familyId: familyOther.id, name: '合成隔离档案' })).body;
    mainAccountId = users[0];
    ownedAProfileId = profileA.id;
    for (const [client, token, profile, operation] of [
      ['owner-a-initial', tokenA, profileA, 'relationship-a-patient'],
      ['owner-a-initial', tokenA, profileB, 'relationship-b-patient'],
      ['owner-other', tokenOther, profileOther, 'relationship-other-patient']
    ]) {
      const relationship = await care(client, token, `/care/profiles/${profile.id}/commands`, 'POST', {
        action: 'relationship', operationId: operation, value: { role: 'patient' }
      });
      assert.equal(relationship.status, 200);
      assert.equal(relationship.body.relationship.role, 'patient');
    }
    const favorite = async (client, token, profileId, markerId, sentence) => care(client, token, `/care/profiles/${profileId}/commands`, 'POST', {
      action: 'put', kind: 'favorite', resourceId: markerId, operationId: `${markerId}-put`, baseVersion: 0,
      value: { sentence, output: [], lifeContext: '聊天' }
    });
    assert.equal((await favorite('owner-a-initial', tokenA, profileA.id, 'marker-a', '档案标记甲')).status, 200);
    assert.equal((await favorite('owner-a-initial', tokenA, profileB.id, 'marker-b', '档案标记乙')).status, 200);
    assert.equal((await favorite('owner-other', tokenOther, profileOther.id, 'marker-other', '档案标记隔离')).status, 200);
    const initialSelection = await care('owner-a-initial', tokenA, '/care/context', 'PUT', { profileId: profileB.id });
    assert.equal(initialSelection.status, 200);
    assert.equal((await care('owner-other', tokenOther, '/care/context', 'PUT', { profileId: profileOther.id })).status, 200);

    if (serve) {
      writePrivateJson(privateFile, { runId, controlSecret, accounts: credentials.map((value, index) => ({ ...value, userId: users[index] })),
        profiles: { a: profileA.id, b: profileB.id, other: profileOther.id } });
      writePublicJson(readyFile, { port: actualPort, status: 'ready', dbName: databaseName, runId });
      console.log(JSON.stringify({ result: 'ready', serve: true, port: actualPort, dbName: databaseName, runId }));
      await new Promise(resolve => {
        const timer = setTimeout(resolve, ttlSeconds * 1000);
        for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { clearTimeout(timer); resolve(); });
      });
      return;
    }

    const baselineGate = arm(profileA.id);
    let oldA;
    try {
      oldA = care('owner-a-initial', tokenA, '/care/context', 'PUT', {
        profileId: profileA.id,
        expectedSelectionVersion: initialSelection.body.selectionVersion
      });
      await baselineGate.entered;
      const selectedB = await care('owner-a-initial', tokenA, '/care/context', 'PUT', {
        profileId: profileB.id,
        expectedSelectionVersion: initialSelection.body.selectionVersion
      });
      assert.equal(selectedB.status, 200);
      release();
      assert.equal((await oldA).status, 409);
    } finally {
      if (currentGate && !currentGate.released) release();
      if (oldA) await oldA.catch(() => {});
    }


    const fixedLayoutProof={};
    const ids=['grid-a','grid-b','grid-c'];
    const endpoint=`/care/profiles/${profileB.id}`;
    const operation=(kind,resourceId,value,baseVersion=0)=>({kind,resourceId,value,baseVersion,action:'put',operationId:crypto.randomBytes(16).toString('hex')});
    for(const id of ids) assert.equal((await care('owner-a-initial',tokenA,endpoint+'/commands','POST',operation('tile',id,{label:'合成几何'+id}))).status,200);
    const layout={rows:2,columns:3,tileIds:ids,cells:[ids[0],null,ids[1],null,ids[2],null]};
    const value={name:'合成固定图板',tileIds:ids,layout};
    assert.equal((await care('owner-a-initial',tokenA,endpoint+'/commands','POST',operation('board','fixed-grid',value))).status,200);
    const first=(await care('owner-a-initial',tokenA,endpoint)).body;
    assert.equal(first.capabilities.fixedBoardLayout,1);
    const before=first.resources.find(r=>r.kind==='board'&&r.id==='fixed-grid');
    assert.deepEqual(before.value.layout,layout);
    const stale=await care('owner-a-initial',tokenA,endpoint+'/commands','POST',operation('board','fixed-grid',{name:'旧客户端',tileIds:ids},before.version));
    assert.equal(stale.status,409);assert.equal(stale.body.code,'FIXED_BOARD_LAYOUT_REQUIRED');
    const invalid=await care('owner-a-initial',tokenA,endpoint+'/commands','POST',operation('board','fixed-grid',{...value,layout:{...layout,cells:[ids[0],ids[0],ids[1],null,ids[2],null]}},before.version));
    assert.equal(invalid.status,400);
    const after=(await care('owner-a-initial',tokenA,endpoint)).body.resources.find(r=>r.kind==='board'&&r.id==='fixed-grid');
    assert.deepEqual(after,before);
    const update=await care('owner-a-initial',tokenA,endpoint+'/commands','POST',operation('board','fixed-grid',{...value,name:'合成明确更新'},before.version));
    assert.equal(update.status,200);
    const final=(await care('owner-a-initial',tokenA,endpoint)).body.resources.find(r=>r.kind==='board'&&r.id==='fixed-grid');
    assert.deepEqual(final.value.layout,layout);assert.equal(final.version,before.version+1);
    Object.assign(fixedLayoutProof,{exact2x3RoundTrip:true,oldClientOmission409:true,invalidCells400:true,failedWritesPreserveWholeResource:true,explicitUpdatePreservesGeometry:true,serverCapabilityVerified:true});
    const freshOne = await care('owner-a-initial', tokenA, '/care/context');
    const freshTwo = await care('owner-a-initial', tokenA, '/care/context');
    const logout = await care('owner-a-initial', tokenA, '/user/logout', 'POST', {});
    assert.equal(logout.status, 200);
    assert.equal((await care('owner-a-old', tokenA, '/care/context')).status, 401);
    const tokenRelogin = await login('owner-a-relogin', 0);
    const reloginRead = await care('owner-a-relogin', tokenRelogin, '/care/context');
    const otherRead = await care('owner-other', tokenOther, '/care/context');
    const staleNull = await care('owner-a-relogin', tokenRelogin, '/care/context', 'PUT', {
      profileId: null,
      expectedSelectionVersion: reloginRead.body.selectionVersion - 1
    });
    assert.equal(staleNull.status, 409);
    const afterStaleNull = await care('owner-a-relogin', tokenRelogin, '/care/context');
    assert.equal(afterStaleNull.body.selectedProfileId, profileB.id);
    const cleared = await care('owner-a-relogin', tokenRelogin, '/care/context', 'PUT', {
      profileId: null,
      expectedSelectionVersion: afterStaleNull.body.selectionVersion
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.selectedProfileId, null);
    const clearedRead = await care('owner-a-relogin', tokenRelogin, '/care/context');
    assert.equal(clearedRead.body.selectedProfileId, null);
    const restoredB = await care('owner-a-relogin', tokenRelogin, '/care/context', 'PUT', {
      profileId: profileB.id,
      expectedSelectionVersion: clearedRead.body.selectionVersion
    });
    assert.equal(restoredB.status, 200);
    const observed = {
      firstFreshRead: freshOne.body && freshOne.body.selectedProfileId,
      repeatedFreshRead: freshTwo.body && freshTwo.body.selectedProfileId,
      reloginRead: reloginRead.body && reloginRead.body.selectedProfileId,
      otherAccountRead: otherRead.body && otherRead.body.selectedProfileId,
      afterStaleNull: afterStaleNull.body && afterStaleNull.body.selectedProfileId,
      clearedRead: clearedRead.body && clearedRead.body.selectedProfileId,
      restoredB: restoredB.body && restoredB.body.selectedProfileId
    };
    console.log(JSON.stringify({ result: 'observed', runId, databaseName, events, observed: {
      firstFreshReadIsB: observed.firstFreshRead === profileB.id,
      repeatedFreshReadIsB: observed.repeatedFreshRead === profileB.id,
      reloginReadIsB: observed.reloginRead === profileB.id,
      otherAccountUnchanged: observed.otherAccountRead === profileOther.id,
      staleNullRejectedAndBUnchanged: staleNull.status === 409 && observed.afterStaleNull === profileB.id,
      currentNullCleared: observed.clearedRead === null,
      freshVersionRestoredB: observed.restoredB === profileB.id
    }, fixedLayoutProof, staleAStatus: 409, oldSessionStatus: 401, secretsPrinted: false }));
    assert.equal(observed.firstFreshRead, profileB.id);
    assert.equal(observed.repeatedFreshRead, profileB.id);
    assert.equal(observed.reloginRead, profileB.id);
    assert.equal(observed.otherAccountRead, profileOther.id);
    assert.equal(observed.afterStaleNull, profileB.id);
    assert.equal(observed.clearedRead, null);
    assert.equal(observed.restoredB, profileB.id);
  } finally {
    await cleanup();
  }
}

main().catch(async error => {
  console.error(error.name, error.code || error.message);
  try {
    if (mongoose.connection.readyState && mongoose.connection.name === `care_test_${runId}`) {
      await mongoose.connection.dropDatabase();
    }
    if (mongoose.connection.readyState) await mongoose.disconnect();
  } catch (_) {}
  process.exitCode = 1;
});

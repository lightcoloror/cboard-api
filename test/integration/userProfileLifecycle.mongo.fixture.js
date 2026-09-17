'use strict';

const assert = require('assert').strict;
const mockery = require('mockery');

module.exports = async function userProfileLifecycleFixture({ mongoose, passed }) {
  const User = require('../../api/models/User');
  const users = User.collection;
  const accounts = mongoose.connection.collection('careaccountlifecycles');
  const actorId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();
  const oauthId = new mongoose.Types.ObjectId();
  const loginId = new mongoose.Types.ObjectId();
  const ids = [actorId, ownerId, oauthId, loginId];
  const controllerPath = require.resolve('../../api/controllers/user');
  const previousController = require.cache[controllerPath];
  let locate = async () => ({ country: 'Synthetic country' });
  let locationCalls = 0;
  const response = () => ({
    code: 0, body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  });
  mockery.enable({ warnOnReplace: false, warnOnUnregistered: false, useCleanCache: false });
  mockery.registerMock('../mail', { nev: {} });
  mockery.registerMock('../helpers/localize', {
    isLocalIp() { return false; },
    async findIpLocation() { locationCalls += 1; return locate(); }
  });
  mockery.registerMock('../helpers/auth', { issueToken() { return 'synthetic-unused-token'; } });
  mockery.registerMock('../helpers/phoneVerificationRuntime', {
    phoneVerificationService: { async consumeLoginVerification() {} }
  });
  mockery.registerMock('../helpers/authRequestRateLimit', {});
  mockery.registerMock('../helpers/emailVerificationResendRateLimit', {});
  delete require.cache[controllerPath];
  try {
    const controller = require(controllerPath);
    const syntheticPassword = require('bcryptjs').hashSync('synthetic-fixture-password', 4);
    await users.insertMany(ids.map((_id, index) => ({ _id,
      email: `profile-${_id}@example.test`, name: 'Synthetic profile user',
      role: index === 0 ? 'admin' : 'user', authVersion: 0, password: syntheticPassword,
      ...(index === 3 ? { phone: '13900139000' } : {})
    })));
    for (const _id of ids) {
      await accounts.insertOne({ _id: String(_id), status: 'open', lifecycleRev: 0 });
    }
    const update = async (target, body, actor = actorId) => {
      const res = response();
      await controller.updateUser({ user: { id: String(actor), role: actor.equals(actorId) ? 'admin' : 'user' },
        body, ip: '203.0.113.9', swagger: { params: { id: { value: String(target) } } } }, res);
      return res;
    };
    assert.equal((await update(ownerId, { name: 'Updated synthetic name', locale: 'zh' })).code, 200);
    assert.equal((await users.findOne({ _id: ownerId })).name, 'Updated synthetic name');
    assert.equal((await update(ownerId, { email: 'unverified@example.test' })).code, 409);
    assert.equal((await update(actorId, { name: 'Unauthorized' }, ownerId)).code, 403);
    const before = await users.findOne({ _id: ownerId });
    locate = async () => {
      await accounts.updateOne({ _id: String(ownerId) }, { $set: { status: 'closing' } });
      return { country: 'Must not persist' };
    };
    const lookupRace = await update(ownerId, { location: {}, name: 'Must not persist' });
    assert.equal(lookupRace.code, 409);
    assert.equal(lookupRace.body.error.code, 'ACCOUNT_CLOSING');
    assert.deepEqual(await users.findOne({ _id: ownerId }), before);
    await accounts.updateOne({ _id: String(actorId) }, { $set: { status: 'closing' } });
    const actorBlocked = await update(oauthId, { name: 'Blocked administrator' });
    assert.equal(actorBlocked.code, 409);
    assert.equal((await users.findOne({ _id: oauthId })).name, 'Synthetic profile user');
    passed.push('user-profile-update-fences-actor-target-and-location-lookup-race');

    const profile = { id: 'synthetic-provider-id', accessToken: 'synthetic-provider-token',
      displayName: 'Synthetic provider name', emails: [{ value: 'provider@example.test' }] };
    for (const provider of ['Facebook', 'Google', 'Apple']) {
      const existing = await User.findById(oauthId).exec();
      await User[`updateUserFrom${provider}`](profile, existing);
      const stored = await users.findOne({ _id: oauthId });
      assert.equal(stored[provider.toLowerCase()].id, profile.id);
      assert.equal(stored.email, `profile-${oauthId}@example.test`);
      assert.equal(stored.role, 'user');
    }
    const oauthBefore = await users.findOne({ _id: oauthId });
    for (const status of ['closing', 'closed']) {
      await accounts.updateOne({ _id: String(oauthId) }, { $set: { status } });
      for (const provider of ['Facebook', 'Google', 'Apple']) {
        const existing = await User.findById(oauthId).exec();
        await assert.rejects(User[`updateUserFrom${provider}`]({ ...profile, id: 'changed' }, existing),
          error => error.code === (status === 'closed' ? 'ACCOUNT_CLOSED' : 'ACCOUNT_CLOSING'));
      }
      assert.deepEqual(await users.findOne({ _id: oauthId }), oauthBefore);
    }
    passed.push('existing-oauth-user-updates-preserve-identity-and-refuse-closing-closed');

    // Exercise the actual login call site; provider checks and token generation
    // are synthetic, while sessions, User, Settings and lifecycle use Mongo.
    const login = async () => {
      const res = response();
      await controller.loginUserWithPhone({ body: { phone: '13900139000', phoneVerificationToken: 'synthetic' },
        session: {}, ip: '203.0.113.9', get() { return 'synthetic-device'; } }, res);
      return res;
    };
    locate = async () => ({ country: 'Initial synthetic country' });
    assert.equal((await login()).code, 200);
    assert.equal((await users.findOne({ _id: loginId })).location.country, 'Initial synthetic country');
    await users.updateOne({ _id: loginId }, { $unset: { location: '' } });
    locate = async () => {
      await users.updateOne({ _id: loginId }, { $set: { location: { country: 'Other device country' } } });
      return { country: 'Stale lookup country' };
    };
    assert.equal((await login()).code, 200);
    assert.equal((await users.findOne({ _id: loginId })).location.country, 'Other device country');
    await users.updateOne({ _id: loginId }, { $unset: { location: '' } });
    locate = async () => {
      await accounts.updateOne({ _id: String(loginId) }, { $set: { status: 'closing' } });
      return { country: 'Must not persist' };
    };
    await login();
    assert.equal((await users.findOne({ _id: loginId })).location, undefined);
    assert.equal(locationCalls, 4);
    passed.push('login-location-save-fences-closure-and-preserves-concurrent-location');
  } finally {
    delete require.cache[controllerPath];
    if (previousController) require.cache[controllerPath] = previousController;
    mockery.deregisterAll();
    mockery.disable();
  }
};

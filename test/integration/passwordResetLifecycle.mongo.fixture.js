'use strict';

const assert = require('assert').strict;
const bcrypt = require('bcryptjs');
const mockery = require('mockery');
const { hashResetToken } = require('../../api/helpers/passwordReset');

function response() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function request(body, ip = '127.0.0.1') {
  return { body, ip, headers: { origin: 'http://localhost:3000' } };
}

module.exports = async function passwordResetLifecycleMongoFixture({
  mongoose,
  passed
}) {
  const oldFlag = process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
  const sent = [];
  let phoneVerificationCalls = 0;
  const connection = mongoose.connection;
  const User = require('../../api/models/User');
  const ResetPassword = require('../../api/models/ResetPassword');
  const accounts = connection.db.collection('careaccountlifecycles');
  const users = connection.db.collection('users');
  const resets = ResetPassword.collection;
  const ids = [];

  mockery.enable({ warnOnReplace: false, warnOnUnregistered: false, useCleanCache: false });
  mockery.registerMock('../mail', {
    nev: {
      options: {},
      sendResetPasswordEmail(email, origin, userId, token, callback) {
        sent.push({ email, origin, userId, token });
        callback();
      }
    }
  });
  mockery.registerMock('../helpers/localize', {
    async findIpLocation() { return null; },
    isLocalIp() { return true; }
  });
  mockery.registerMock('../helpers/phoneVerificationRuntime', {
    phoneVerificationService: {
      async consumePasswordResetVerification(value) {
        phoneVerificationCalls += 1;
        return { verified: true, value };
      }
    }
  });
  mockery.registerMock('../helpers/authRequestRateLimit', {
    getAuthRequestLimiters() { return {}; },
    async consumeAuthRequestLimits() {}
  });
  mockery.registerMock('../helpers/emailVerificationResendRateLimit', {
    async consumeEmailVerificationResendLimits() {},
    emailVerificationResendRateLimit: null
  });
  mockery.registerMock('../helpers/auth', {});
  mockery.registerMock('../../config', {
    CBOARD_PROD_URL: 'https://app.example.test',
    CBOARD_QA_URL: 'https://qa.example.test',
    LOCALHOST_PORT_3000_URL: 'http://localhost:3000',
    CBOARD_APP_URL: 'https://app.example.test',
    emailTransport: {
      from: 'No Reply <noreply@example.test>',
      host: 'smtp.example.test',
      auth: { user: 'apikey', pass: 'synthetic-pass' }
    }
  });

  process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
  const controller = require('../../api/controllers/user');
  const id = new mongoose.Types.ObjectId();
  ids.push(id);
  const email = `reset-${id.toString()}@example.test`;
  const seedUser = async (overrides = {}) => {
    await User.create({
      _id: id,
      name: 'Synthetic password reset user',
      email,
      phone: '13800138000',
      role: 'user',
      password: 'old-password',
      authVersion: 0,
      ...overrides
    });
    await accounts.updateOne(
      { _id: id.toString() },
      { $set: { status: 'open', lifecycleRev: 0 } },
      { upsert: true }
    );
  };
  const issue = async () => {
    const res = response();
    await controller.forgotPassword(request({ email }), res);
    assert.equal(res.statusCode, 200);
    return res;
  };
  const originalUserFindOneAndUpdate = User.findOneAndUpdate;
  const originalResetFindOneAndUpdate = ResetPassword.findOneAndUpdate;

  try {
    await seedUser();
    await issue();
    const issued = await ResetPassword.findOne({ userId: id.toString() }).lean().exec();
    assert(issued && issued.status === false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].userId, id.toString());
    assert.equal(Object.prototype.hasOwnProperty.call(sent[0], 'token'), true);
    passed.push('password-reset-email-issue-real-token-record');

    const storeResponse = response();
    await controller.storePassword(request({
      userid: id.toString(),
      token: sent[0].token,
      password: 'new-password-strong'
    }), storeResponse);
    assert.equal(storeResponse.statusCode, 200);
    const storedUser = await User.findById(id).select('+password').lean().exec();
    assert.equal(storedUser.authVersion, 1);
    assert.equal(await bcrypt.compare('new-password-strong', storedUser.password), true);
    assert.equal((await ResetPassword.findOne({ userId: id.toString() })).status, true);
    passed.push('password-reset-store-atomic-auth-version-and-consume');

    await ResetPassword.updateOne({ userId: id.toString() }, {
      $set: { status: false, resetPasswordExpires: new Date(Date.now() + 60000) }
    });
    await issue();
    const raceToken = sent[sent.length - 1].token;
    const raceRecord = await ResetPassword.findOne({ userId: id.toString() }).lean().exec();
    let raceInjected = false;
    ResetPassword.findOneAndUpdate = function(...args) {
      const query = originalResetFindOneAndUpdate.apply(this, args);
      const execute = query.exec.bind(query);
      query.exec = async () => {
        if (!raceInjected) {
          raceInjected = true;
          await resets.updateOne(
            { _id: raceRecord._id },
            { $set: { resetPasswordToken: await hashResetToken('replacement-token') } }
          );
        }
        return execute();
      };
      return query;
    };
    const raceResponse = response();
    await controller.storePassword(request({
      userid: id.toString(), token: raceToken, password: 'race-password-strong'
    }), raceResponse);
    ResetPassword.findOneAndUpdate = originalResetFindOneAndUpdate;
    assert.notEqual(raceResponse.statusCode, 200);
    assert.equal((await ResetPassword.findOne({ userId: id.toString() })).status, false);
    assert.equal((await User.findById(id).lean().exec()).authVersion, 1);
    passed.push('password-reset-hash-replacement-race-rejected');

    await ResetPassword.updateOne({ userId: id.toString() }, {
      $set: { status: false, resetPasswordExpires: new Date(Date.now() + 60000) }
    });
    const missingId = new mongoose.Types.ObjectId();
    ids.push(missingId);
    const missingToken = 'a'.repeat(64);
    await ResetPassword.create({
      userId: missingId.toString(),
      resetPasswordToken: await hashResetToken(missingToken),
      resetPasswordExpires: new Date(Date.now() + 60000),
      status: false
    });
    await accounts.updateOne(
      { _id: missingId.toString() },
      { $set: { status: 'open', lifecycleRev: 0 } },
      { upsert: true }
    );
    const missingResponse = response();
    await controller.storePassword(request({
      userid: missingId.toString(), token: missingToken, password: 'new-password-strong'
    }), missingResponse);
    assert.equal(missingResponse.statusCode, 400);
    assert.equal((await ResetPassword.findOne({ userId: missingId.toString() })).status, false);
    passed.push('password-reset-missing-user-rolls-back-token-consume');

    await issue();
    const beforeBlocked = await resets.findOne({ userId: id.toString() });
    const beforeBlockedUser = await users.findOne({ _id: id });
    const sentBeforeBlocked = sent.length;
    for (const status of ['closing', 'closed']) {
      await accounts.updateOne({ _id: id.toString() }, { $set: { status } });
      const closingResponse = response();
      await controller.forgotPassword(request({ email }), closingResponse);
      assert.equal(closingResponse.statusCode, 200);
      assert.equal(sent.length, sentBeforeBlocked);
      const blockedStore = response();
      await controller.storePassword(request({ userid: id.toString(),
        token: sent[sent.length - 1].token, password: 'blocked-password-strong' }), blockedStore);
      assert.equal(blockedStore.statusCode, 400);
      assert.deepEqual(await resets.findOne({ userId: id.toString() }), beforeBlocked);
      assert.deepEqual(await users.findOne({ _id: id }), beforeBlockedUser);
    }
    passed.push('password-reset-closing-and-closed-do-not-send-consume-or-rebuild');

    await accounts.updateOne({ _id: id.toString() }, { $set: { status: 'closed' } });
    const phoneResponse = response();
    await controller.resetPasswordWithPhone({ body: {
      phone: '13800138000', phoneVerificationToken: 'b'.repeat(64), password: 'phone-password-strong'
    } }, phoneResponse);
    assert.equal(phoneResponse.statusCode, 400);
    assert.equal(phoneVerificationCalls, 1);
    assert.deepEqual(await resets.findOne({ userId: id.toString() }), beforeBlocked);
    assert.deepEqual(await users.findOne({ _id: id }), beforeBlockedUser);
    await accounts.updateOne({ _id: id.toString() }, { $set: { status: 'open' } });
    passed.push('password-reset-closed-phone-no-write');

    await ResetPassword.updateOne({ userId: id.toString() }, {
      $set: { status: false, resetPasswordExpires: new Date(Date.now() + 60000) }
    });
    User.findOneAndUpdate = function(...args) {
      throw new Error('synthetic injected user update failure');
    };
    const failedPhone = response();
    await controller.resetPasswordWithPhone({ body: {
      phone: '13800138000', phoneVerificationToken: 'c'.repeat(64), password: 'phone-password-strong'
    } }, failedPhone);
    User.findOneAndUpdate = originalUserFindOneAndUpdate;
    ResetPassword.findOneAndUpdate = originalResetFindOneAndUpdate;
    assert.equal(failedPhone.statusCode, 500);
    assert.equal(phoneVerificationCalls, 2);
    assert.equal((await ResetPassword.findOne({ userId: id.toString() })).status, false);
    assert.deepEqual(await users.findOne({ _id: id }), beforeBlockedUser);
    passed.push('password-reset-phone-two-writes-rollback');
  } finally {
    User.findOneAndUpdate = originalUserFindOneAndUpdate;
    ResetPassword.findOneAndUpdate = originalResetFindOneAndUpdate;
    await resets.deleteMany({ userId: { $in: ids.map(value => value.toString()) } });
    await users.deleteMany({ _id: { $in: ids } });
    await accounts.deleteMany({ _id: { $in: ids.map(value => value.toString()) } });
    if (oldFlag === undefined) delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    else process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = oldFlag;
    mockery.deregisterAll();
    mockery.disable();
  }
};

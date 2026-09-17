'use strict';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('user profile lifecycle update', function() {
  let controller;
  let userRecord;
  let databaseCalls;
  let lifecycleCalls;
  let lifecycleMode;
  let lifecycleSession;
  let lifecycleActive;
  let locationCalls;
  let localIp;
  let previousFlag;

  beforeEach(function() {
    previousFlag = process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    databaseCalls = [];
    lifecycleCalls = [];
    lifecycleMode = 'open';
    lifecycleSession = { id: 'profile-session' };
    lifecycleActive = false;
    locationCalls = [];
    localIp = false;
    userRecord = {
      _id: 'target-1',
      id: 'target-1',
      email: 'target@example.test',
      name: 'Before',
      location: {},
      toJSON() { return { id: this.id, name: this.name, location: this.location }; },
      async save(options) {
        databaseCalls.push('save');
        this.saveOptions = options;
        return this;
      }
    };
    const User = {
      findById(id) {
        databaseCalls.push(`find:${id}`);
        const query = {
          session(value) {
            this.sessionValue = value;
            return this;
          },
          async exec() {
            return id === 'target-1' ? userRecord : null;
          }
        };
        return query;
      }
    };

    mockery.enable({ warnOnReplace: false, warnOnUnregistered: false, useCleanCache: true });
    mockery.registerMock('../models/User', User);
    mockery.registerMock('../models/ResetPassword', {});
    mockery.registerMock('../models/Settings', {});
    mockery.registerMock('../models/Subscribers', {});
    mockery.registerMock('../mail', { nev: { options: {} } });
    mockery.registerMock('../helpers/auth', {});
    mockery.registerMock('../helpers/phoneVerificationRuntime', { phoneVerificationService: {} });
    mockery.registerMock('../helpers/authRequestRateLimit', {
      getAuthRequestLimiters() { return {}; },
      async consumeAuthRequestLimits() {}
    });
    mockery.registerMock('../helpers/emailVerificationResendRateLimit', {
      async consumeEmailVerificationResendLimits() {},
      emailVerificationResendRateLimit: null
    });
    mockery.registerMock('../helpers/localize', {
      isLocalIp() { return localIp; },
      async findIpLocation(ip) {
        locationCalls.push({ ip, lifecycleActive });
        return { country: 'CN', city: 'Shanghai' };
      }
    });
    mockery.registerMock('../helpers/careFamilyLifecycle', {
      createCareFamilyLifecycle() {
        return {
          async withOpenFamilyAccounts(familyId, accountIds, callback) {
            lifecycleCalls.push({ familyId, accountIds });
            if (lifecycleMode === 'closing') {
              throw Object.assign(new Error('closing'), { code: 'ACCOUNT_CLOSING', status: 409 });
            }
            if (lifecycleMode === 'closed') {
              throw Object.assign(new Error('closed'), { code: 'ACCOUNT_CLOSED', status: 403 });
            }
            if (lifecycleMode === 'missing-inside') userRecord = null;
            lifecycleActive = true;
            const result = await callback(lifecycleSession);
            lifecycleActive = false;
            if (lifecycleMode === 'commit-fail') throw new Error('commit failed');
            return result;
          }
        };
      }
    });
    mockery.registerMock('../helpers/userAccess', {
      requireAdmin() { return { ok: true, status: 200, id: 'actor-1' }; },
      requireSelfOrAdmin(req, id) {
        if (!req.user || !req.auth || req.auth.id !== req.user.id) {
          return { ok: false, status: 401, body: { error: { code: 'AUTH_REQUIRED' } } };
        }
        return { ok: true, status: 200, id: req.user.id };
      }
    });
    mockery.registerMock('../../config', {
      emailTransport: { from: 'No Reply <noreply@example.test>', host: 'smtp.example.test', auth: { user: 'u', pass: 'p' } }
    });
    controller = require('../../api/controllers/user');
  });

  afterEach(function() {
    if (previousFlag === undefined) delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    else process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = previousFlag;
    mockery.deregisterAll();
    mockery.disable();
  });

  function response() {
    return {
      statusCode: 0,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
  }

  function request(body = {}, actor = 'target-1', target = 'target-1') {
    return {
      body,
      ip: '203.0.113.5',
      user: { id: actor, role: actor === 'actor-1' ? 'admin' : 'user' },
      auth: { id: actor },
      swagger: { params: { id: { value: target } } }
    };
  }

  it('locks actor and target, rereads User, and saves with one session', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    const res = response();
    await controller.updateUser(request({ name: 'After' }, 'actor-1'), res);
    expect(res.statusCode).to.equal(200);
    expect(lifecycleCalls).to.deep.equal([
      { familyId: null, accountIds: ['actor-1', 'target-1'] }
    ]);
    expect(userRecord.name).to.equal('After');
    expect(userRecord.saveOptions).to.deep.equal({ session: lifecycleSession });
  });

  it('does IP location lookup outside the transaction and preserves an existing country', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    userRecord.location = { country: 'US', city: 'Existing' };
    const res = response();
    await controller.updateUser(request({ location: { city: 'Client' } }), res);
    expect(res.statusCode).to.equal(200);
    expect(locationCalls).to.deep.equal([]);
    expect(userRecord.location).to.deep.equal({ country: 'US', city: 'Existing' });
  });

  it('does not accept client location data from a local IP', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    localIp = true;
    userRecord.location = {};
    const res = response();
    await controller.updateUser(request({ location: { country: 'FAKE', city: 'Client' } }), res);
    expect(res.statusCode).to.equal(200);
    expect(userRecord.location).to.deep.equal({});
    expect(locationCalls).to.deep.equal([]);
  });

  it('performs the actual location lookup before entering the transaction', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    const res = response();
    await controller.updateUser(request({ location: { country: 'Client fake' } }), res);
    expect(res.statusCode).to.equal(200);
    expect(locationCalls).to.deep.equal([{ ip: '203.0.113.5', lifecycleActive: false }]);
    expect(userRecord.location).to.deep.equal({ country: 'CN', city: 'Shanghai' });
    expect(userRecord.saveOptions).to.deep.equal({ session: lifecycleSession });
  });

  it('rejects email changes before any User read or lifecycle lock', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    const res = response();
    await controller.updateUser(request({ email: 'new@example.test' }), res);
    expect(res.statusCode).to.equal(409);
    expect(res.body.error.code).to.equal('EMAIL_CHANGE_REQUIRES_VERIFICATION');
    expect(databaseCalls).to.deep.equal([]);
    expect(lifecycleCalls).to.deep.equal([]);
  });

  it('returns stable closing error without saving', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    lifecycleMode = 'closing';
    const res = response();
    await controller.updateUser(request({ name: 'Blocked' }, 'actor-1'), res);
    expect(res.statusCode).to.equal(409);
    expect(res.body.error.code).to.equal('ACCOUNT_CLOSING');
    expect(databaseCalls).not.to.include('save');
  });

  it('returns stable closed error without saving', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    lifecycleMode = 'closed';
    const res = response();
    await controller.updateUser(request({ name: 'Blocked' }, 'actor-1'), res);
    expect(res.statusCode).to.equal(403);
    expect(res.body.error.code).to.equal('ACCOUNT_CLOSED');
    expect(databaseCalls).not.to.include('save');
  });

  it('returns 404 when the target exists initially but disappears on gate reread', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    lifecycleMode = 'missing-inside';
    const res = response();
    await controller.updateUser(request({ name: 'Missing' }, 'actor-1'), res);
    expect(res.statusCode).to.equal(404);
    expect(databaseCalls).to.deep.equal(['find:target-1', 'find:target-1']);
    expect(userRecord).to.equal(null);
  });

  it('does not return success after a lifecycle commit failure', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    lifecycleMode = 'commit-fail';
    const res = response();
    await controller.updateUser(request({ name: 'Commit race' }, 'actor-1'), res);
    expect(res.statusCode).to.equal(500);
    expect(res.body.error.code).to.equal('USER_UPDATE_FAILED');
  });

  it('keeps the flag-off save path compatible', async function() {
    const res = response();
    await controller.updateUser(request({ name: 'Legacy' }), res);
    expect(res.statusCode).to.equal(200);
    expect(lifecycleCalls).to.deep.equal([]);
    expect(userRecord.saveOptions).to.equal(undefined);
  });
});

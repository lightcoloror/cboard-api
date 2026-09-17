'use strict';

const chai = require('chai');
const mockery = require('mockery');
const YAML = require('yamljs');

const expect = chai.expect;

describe('user controller access guards', function() {
  let controller;
  let databaseCalls;
  let careChecks;
  let paginatedCalls;
  let userRecord;

  beforeEach(function() {
    databaseCalls = [];
    careChecks = 0;
    paginatedCalls = 0;
    userRecord = {
      id: 'user-1',
      toJSON() {
        return { id: this.id, role: 'user' };
      },
      save: async function() {
        databaseCalls.push('save');
        return this;
      }
    };

    const User = {
      findById(id) {
        databaseCalls.push(`find:${id}`);
        return {
          exec(callback) {
            if (callback) return callback(null, userRecord);
            return Promise.resolve(userRecord);
          }
        };
      },
      findByIdAndRemove(id, callback) {
        databaseCalls.push(`delete:${id}`);
        callback(null, { id });
      }
    };

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('../models/User', User);
    mockery.registerMock('../models/ResetPassword', {});
    mockery.registerMock('../models/Settings', {
      async getOrCreate() {
        databaseCalls.push('settings');
        return {};
      }
    });
    mockery.registerMock('../models/Subscribers', {});
    mockery.registerMock('../mail', { nev: { options: {} } });
    mockery.registerMock('../helpers/auth', {});
    mockery.registerMock('../helpers/phoneVerificationRuntime', {
      phoneVerificationService: {}
    });
    mockery.registerMock('../helpers/careAccountDeletion', {
      async getCareAccountDeletionBlocker() {
        careChecks += 1;
        return null;
      }
    });
    mockery.registerMock('../helpers/localize', {
      async findIpLocation() {
        return null;
      },
      isLocalIp() {
        return true;
      }
    });
    mockery.registerMock('../helpers/response', {
      async paginatedResponse() {
        paginatedCalls += 1;
        return { data: [] };
      }
    });
    mockery.registerMock('../../config', {
      emailTransport: { from: 'No Reply <noreply@example.test>', host: 'smtp.example.test', auth: { user: 'u', pass: 'p' } }
    });
    controller = require('../../api/controllers/user');
  });

  afterEach(function() {
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

  function request(id, user, auth) {
    return {
      swagger: { params: { id: { value: id } } },
      user,
      auth
    };
  }

  it('rejects list access before reading query or calling pagination', async function() {
    const res = response();
    await controller.listUser({ user: { id: 'user-1', role: 'user' } }, res);
    expect(res.statusCode).to.equal(403);
    expect(res.body.error.code).to.equal('USER_ACCESS_FORBIDDEN');
    expect(paginatedCalls).to.equal(0);
  });

  it('allows an authenticated platform admin to list users', async function() {
    const res = response();
    await controller.listUser(
      { user: { id: 'admin-1', role: 'admin' }, auth: { id: 'admin-1' }, query: {} },
      res
    );
    expect(res.statusCode).to.equal(200);
    expect(paginatedCalls).to.equal(1);
  });

  it('rejects cross-user get before database or settings access', async function() {
    const res = response();
    await controller.getUser(
      request('user-2', { id: 'user-1', role: 'user' }, { id: 'user-1' }),
      res
    );
    expect(res.statusCode).to.equal(403);
    expect(res.body.error.code).to.equal('USER_ACCESS_FORBIDDEN');
    expect(databaseCalls).to.deep.equal([]);
  });

  it('allows self get and only then reads the user and settings', async function() {
    const res = response();
    await controller.getUser(
      request('user-1', { id: 'user-1', role: 'user' }, { id: 'user-1' }),
      res
    );
    expect(res.statusCode).to.equal(200);
    expect(databaseCalls).to.deep.equal(['find:user-1', 'settings']);
  });

  it('rejects delete and update before their side effects on auth mismatch', async function() {
    const deleteRes = response();
    await controller.removeUser(
      request('user-1', { id: 'admin-1', role: 'admin' }, { id: 'other' }),
      deleteRes
    );
    expect(deleteRes.statusCode).to.equal(401);
    expect(careChecks).to.equal(0);

    const updateRes = response();
    await controller.updateUser(
      { ...request('user-1', { id: 'user-1', role: 'user' }, { id: 'other' }), body: {} },
      updateRes
    );
    expect(updateRes.statusCode).to.equal(401);
    expect(databaseCalls).to.deep.equal([]);
  });

  it('declares list users as admin-only in the Swagger contract', function() {
    const spec = YAML.load('api/swagger/swagger.yaml');
    const listOperation = spec.paths['/user'].get;
    expect(listOperation['x-security-scopes']).to.deep.equal(['admin']);
  });
});

'use strict';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('legacy user deletion controller care guard', function() {
  let controller;
  let blocker;
  let deletedId;
  let blockerChecks;

  beforeEach(function() {
    blocker = null;
    deletedId = null;
    blockerChecks = 0;

    const User = {
      findByIdAndRemove(id, callback) {
        deletedId = id;
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
    mockery.registerMock('../models/Settings', {});
    mockery.registerMock('../models/Subscribers', {});
    mockery.registerMock('../mail', { nev: { options: {} } });
    mockery.registerMock('../helpers/auth', {});
    mockery.registerMock('../helpers/phoneVerificationRuntime', {
      phoneVerificationService: {}
    });
    mockery.registerMock('../helpers/careAccountDeletion', {
      async getCareAccountDeletionBlocker() {
        blockerChecks += 1;
        return blocker;
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
    mockery.registerMock('../../config', {
      CBOARD_PROD_URL: 'https://app.example.test',
      CBOARD_QA_URL: 'https://qa.example.test',
      LOCALHOST_PORT_3000_URL: 'http://localhost:3000',
      emailTransport: { from: 'No Reply <noreply@example.test>', host: 'smtp.example.test', auth: { user: 'apikey', pass: 'test' } }
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
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      }
    };
  }

  function request(id = 'user-1') {
    return {
      swagger: { params: { id: { value: id } } },
      user: { id: 'admin-1', role: 'admin' },
      auth: { id: 'admin-1' }
    };
  }

  it('rejects a non-admin before checking family ownership or deleting', async function() {
    const res = response();
    const req = request();
    req.user = { id: 'user-1', role: 'user' };
    req.auth = { id: 'user-1' };

    await controller.removeUser(req, res);

    expect(res.statusCode).to.equal(403);
    expect(res.body.error.code).to.equal('USER_ACCESS_FORBIDDEN');
    expect(blockerChecks).to.equal(0);
    expect(deletedId).to.equal(null);
  });

  it('rejects an admin with a mismatched auth identity before deletion', async function() {
    const res = response();
    const req = request();
    req.auth = { id: 'different-admin' };

    await controller.removeUser(req, res);

    expect(res.statusCode).to.equal(401);
    expect(res.body.error.code).to.equal('USER_ACCESS_UNAUTHORIZED');
    expect(blockerChecks).to.equal(0);
    expect(deletedId).to.equal(null);
  });

  it('blocks the Swagger-reachable legacy delete when the account owns a family', async function() {
    blocker = {
      status: 409,
      message: 'Transfer family administration before deleting this account',
      error: {
        code: 'FAMILY_TRANSFER_REQUIRED',
        requiredAction: 'transfer_administrator',
        families: [{ familyId: 'family-a' }]
      }
    };
    const res = response();

    await controller.removeUser(request(), res);

    expect(res.statusCode).to.equal(409);
    expect(res.body).to.deep.equal({
      message: blocker.message,
      error: blocker.error
    });
    expect(deletedId).to.equal(null);
  });

  it('fails closed when family ownership cannot be checked', async function() {
    blocker = {
      status: 503,
      message: 'Unable to verify family administration before deleting account',
      error: { code: 'CARE_FAMILY_CHECK_UNAVAILABLE' }
    };
    const res = response();

    await controller.removeUser(request(), res);

    expect(res.statusCode).to.equal(503);
    expect(res.body).to.deep.equal({
      message: blocker.message,
      error: blocker.error
    });
    expect(deletedId).to.equal(null);
  });

  it('retains the existing deletion path after the shared guard allows it', async function() {
    const res = response();

    await controller.removeUser(request('user-2'), res);

    expect(deletedId).to.equal('user-2');
    expect(res.statusCode).to.equal(200);
    expect(res.body).to.deep.equal({ id: 'user-2' });
  });
});

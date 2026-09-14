'use strict';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('legacy user deletion controller care guard', function() {
  let controller;
  let blocker;
  let deletedId;

  beforeEach(function() {
    blocker = null;
    deletedId = null;

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
      emailTransport: { host: 'smtp.example.test', auth: { user: 'apikey', pass: 'test' } }
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
    return { swagger: { params: { id: { value: id } } } };
  }

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

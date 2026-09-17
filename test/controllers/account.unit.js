'use strict';

process.env.NODE_ENV = 'test';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('Account deletion controller', function() {
  let controller;
  let requestedBy;
  let deletedFilters;
  let careDeletionBlocker;
  let sessionRevokeError;
  let sessionDestroyError;
  let userMissing;
  let settingsFailure;
  let careAccountFailure;

  beforeEach(function() {
    requestedBy = 'user-1';
    deletedFilters = {};
    careDeletionBlocker = null;
    sessionRevokeError = null;
    sessionDestroyError = null;
    userMissing = false;
    settingsFailure = false;
    careAccountFailure = false;

    const models = {
      '../models/User': {
        async findById(id) {
          deletedFilters.userLookup = id;
          if (userMissing) return null;
          return { id, email: 'care@example.test' };
        },
        async findByIdAndRemove(id) {
          deletedFilters.user = id;
          if (userMissing) return null;
          return { id, email: 'care@example.test' };
        }
      },
      '../models/Settings': {
        async findOneAndDelete(filter) {
          deletedFilters.settings = filter;
          if (settingsFailure) throw new Error('settings unavailable');
          return { user: filter.user };
        }
      },
      '../models/Communicator': {
        async deleteMany(filter) {
          deletedFilters.communicators = filter;
          return { deletedCount: 2 };
        }
      },
      '../models/Board': {
        async deleteMany(filter) {
          deletedFilters.boards = filter;
          return { deletedCount: 3 };
        }
      },
      '../models/Subscribers': {
        async findOneAndRemove(filter) {
          deletedFilters.subscriber = filter;
          return { userId: filter.userId };
        }
      },
      '../models/CommunicationReceiverRecord': {
        async deleteMany(filter) {
          deletedFilters.receiverRecords = filter;
          return { deletedCount: 4 };
        }
      },
      '../models/CommunicationSavedPhrase': {
        async deleteMany(filter) {
          deletedFilters.savedPhrases = filter;
          return { deletedCount: 5 };
        }
      },
      '../models/CommunicationAiUsage': {
        async deleteMany(filter) {
          deletedFilters.aiUsage = filter;
          return { deletedCount: 6 };
        }
      },
      '../models/CareWorkspace': {
        Account: {
          async deleteOne(filter) {
            deletedFilters.careAccount = filter;
            if (careAccountFailure) throw new Error('care account unavailable');
            return { deletedCount: 1 };
          }
        }
      }
    };

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    Object.entries(models).forEach(([name, model]) => {
      mockery.registerMock(name, model);
    });
    mockery.registerMock('../helpers/auth', {
      getAuthDataFromReq() {
        return { requestedBy, isAdmin: false };
      }
    });
    mockery.registerMock('../helpers/deviceSessions', {
      async revoke(userId) {
        deletedFilters.sessionRevoke = userId;
        if (sessionRevokeError) throw sessionRevokeError;
      }
    });
    mockery.registerMock('../helpers/careAccountDeletion', {
      async getCareAccountDeletionBlocker(id) {
        deletedFilters.careAccountDeletion = id;
        return careDeletionBlocker;
      }
    });
    mockery.registerMock('./communicationPrivateLibrary', {
      async deletePrivateLibraryForUser(id) {
        deletedFilters.privateLibrary = id;
        return true;
      }
    });
    mockery.registerMock('./communicationPrivateDeviceData', {
      async deletePrivateDeviceDataForUser(id) {
        deletedFilters.privateDeviceData = id;
        return true;
      }
    });
    controller = require('../../api/controllers/account');
  });

  afterEach(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  function createResponse() {
    return {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      }
    };
  }

  function createRequest(id = 'user-1') {
    return {
      swagger: { params: { id: { value: id } } },
      user: { id: 'user-1', role: 'user', isAdmin: false },
      session: {
        destroy(callback) {
          deletedFilters.sessionDestroy = true;
          if (sessionDestroyError) return callback(sessionDestroyError);
          callback(null);
        }
      },
      communicationAiTokenQuotaService: {
        async deleteUserQuota(input) {
          deletedFilters.aiTokenQuota = input;
          return true;
        }
      }
    };
  }

  function createAdminRequest(id = 'user-2') {
    const req = createRequest(id);
    req.user = { id: 'admin-1', role: 'admin', isAdmin: true };
    return req;
  }

  it('allows the owner and removes communication sync data with the account', async function() {
    const res = createResponse();

    await controller.removeAccount(createRequest(), res);

    expect(res.statusCode).to.equal(200);
    expect(deletedFilters.receiverRecords).to.deep.equal({ user: 'user-1' });
    expect(deletedFilters.savedPhrases).to.deep.equal({ user: 'user-1' });
    expect(deletedFilters.aiUsage).to.deep.equal({ user: 'user-1' });
    expect(deletedFilters.aiTokenQuota).to.deep.equal({ userId: 'user-1' });
    expect(deletedFilters.privateLibrary).to.equal('user-1');
    expect(deletedFilters.privateDeviceData).to.equal('user-1');
    expect(res.body.deletedCommunicationReceiverRecords).to.equal(4);
    expect(res.body.deletedCommunicationSavedPhrases).to.equal(5);
    expect(res.body.deletedCommunicationAiUsage).to.equal(6);
    expect(res.body.deletedCommunicationAiTokenQuota).to.equal(true);
    expect(res.body.deletedCommunicationPrivateLibrary).to.equal(true);
    expect(res.body.deletedCommunicationPrivateDeviceData).to.equal(true);
    expect(res.body).not.to.have.property('user');
    expect(res.body).not.to.have.property('userEmail');
    expect(deletedFilters.sessionRevoke).to.equal('user-1');
    expect(deletedFilters.sessionDestroy).to.equal(true);
    expect(deletedFilters.careAccount).to.deep.equal({ _id: 'user-1' });
    expect(res.body.deletedCareAccount).to.equal(1);
  });

  it('rejects a different non-admin user before deleting anything', async function() {
    const req = createRequest();
    req.user.id = 'user-2';
    const res = createResponse();

    await controller.removeAccount(req, res);

    expect(res.statusCode).to.equal(403);
    expect(deletedFilters).to.deep.equal({});
  });

  it('rejects an anonymous request before checking family ownership', async function() {
    const req = createRequest();
    req.user = null;
    const res = createResponse();

    await controller.removeAccount(req, res);

    expect(res.statusCode).to.equal(401);
    expect(deletedFilters).to.deep.equal({});
  });

  it('rejects an isAdmin flag without an administrator role', async function() {
    const req = createRequest('user-2');
    req.user.isAdmin = true;
    const res = createResponse();
    await controller.removeAccount(req, res);
    expect(res.statusCode).to.equal(403);
    expect(deletedFilters).to.deep.equal({});
  });

  it('rejects a mismatched authenticated identity before any cleanup', async function() {
    const req = createAdminRequest();
    req.auth = { id: 'other-admin' };
    const res = createResponse();
    await controller.removeAccount(req, res);
    expect(res.statusCode).to.equal(401);
    expect(deletedFilters).to.deep.equal({});
  });

  it('allows an admin to delete another account without destroying the admin session', async function() {
    const res = createResponse();

    await controller.removeAccount(createAdminRequest(), res);

    expect(res.statusCode).to.equal(200);
    expect(deletedFilters.sessionRevoke).to.equal('user-2');
    expect(deletedFilters).not.to.have.property('sessionDestroy');
  });

  it('returns 404 without touching sessions or private cleanup when the target user is missing', async function() {
    userMissing = true;
    const res = createResponse();

    await controller.removeAccount(createRequest(), res);

    expect(res.statusCode).to.equal(404);
    expect(deletedFilters).to.deep.equal({
      careAccountDeletion: 'user-1',
      userLookup: 'user-1'
    });
    expect(deletedFilters.settings).to.not.exist;
  });

  it('keeps the user when an intermediate cleanup fails and deletes it after retry succeeds', async function() {
    settingsFailure = true;
    let res = createResponse();

    await controller.removeAccount(createRequest(), res);

    expect(res.statusCode).to.equal(500);
    expect(deletedFilters.userLookup).to.equal('user-1');
    expect(deletedFilters).not.to.have.property('user');

    settingsFailure = false;
    deletedFilters = {};
    res = createResponse();
    await controller.removeAccount(createRequest(), res);

    expect(res.statusCode).to.equal(200);
    expect(deletedFilters.userLookup).to.equal('user-1');
    expect(deletedFilters.user).to.equal('user-1');
  });

  it('keeps the user when care account cleanup fails and allows retry', async function() {
    careAccountFailure = true;
    let res = createResponse();

    await controller.removeAccount(createRequest(), res);

    expect(res.statusCode).to.equal(500);
    expect(res.body.error.code).to.equal('CARE_ACCOUNT_CLEANUP_FAILED');
    expect(deletedFilters.careAccount).to.deep.equal({ _id: 'user-1' });
    expect(deletedFilters.user).to.not.exist;

    careAccountFailure = false;
    deletedFilters = {};
    res = createResponse();
    await controller.removeAccount(createRequest(), res);

    expect(res.statusCode).to.equal(200);
    expect(deletedFilters.careAccount).to.deep.equal({ _id: 'user-1' });
    expect(deletedFilters.user).to.equal('user-1');
  });

  it('requires family administration transfer before deleting an active family owner', async function() {
    careDeletionBlocker = {
      status: 409,
      message: 'Transfer family administration before deleting this account',
      error: {
        code: 'FAMILY_TRANSFER_REQUIRED',
        requiredAction: 'transfer_administrator',
        families: [{ familyId: 'family-a' }]
      }
    };
    const res = createResponse();

    await controller.removeAccount(createRequest(), res);

    expect(res.statusCode).to.equal(409);
    expect(res.body).to.deep.equal({
      message: 'Transfer family administration before deleting this account',
      error: {
        code: 'FAMILY_TRANSFER_REQUIRED',
        requiredAction: 'transfer_administrator',
        families: [{ familyId: 'family-a' }]
      }
    });
    expect(deletedFilters).to.deep.equal({ careAccountDeletion: 'user-1' });
  });

  it('fails closed when family administration cannot be checked', async function() {
    careDeletionBlocker = {
      status: 503,
      message: 'Unable to verify family administration before deleting account',
      error: { code: 'CARE_FAMILY_CHECK_UNAVAILABLE' }
    };
    const res = createResponse();

    await controller.removeAccount(createRequest(), res);

    expect(res.statusCode).to.equal(503);
    expect(res.body).to.deep.equal({
      message: 'Unable to verify family administration before deleting account',
      error: { code: 'CARE_FAMILY_CHECK_UNAVAILABLE' }
    });
    expect(deletedFilters).to.deep.equal({ careAccountDeletion: 'user-1' });
  });

  it('does not delete private data or the user when session revocation fails', async function() {
    sessionRevokeError = new Error('storage unavailable');
    const res = createResponse();

    await controller.removeAccount(createRequest(), res);

    expect(res.statusCode).to.equal(503);
    expect(res.body.error.code).to.equal('SESSION_REVOKE_FAILED');
    expect(deletedFilters).to.deep.equal({
      careAccountDeletion: 'user-1',
      userLookup: 'user-1',
      sessionRevoke: 'user-1'
    });
  });

  it('does not delete private data or the user when server session destruction fails', async function() {
    sessionDestroyError = new Error('session unavailable');
    const res = createResponse();

    await controller.removeAccount(createRequest(), res);

    expect(res.statusCode).to.equal(503);
    expect(res.body.error.code).to.equal('SESSION_DESTROY_FAILED');
    expect(deletedFilters).to.deep.equal({
      careAccountDeletion: 'user-1',
      userLookup: 'user-1',
      sessionRevoke: 'user-1',
      sessionDestroy: true
    });
  });
});

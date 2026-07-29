'use strict';

process.env.NODE_ENV = 'test';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('Account deletion controller', function() {
  let controller;
  let requestedBy;
  let deletedFilters;

  beforeEach(function() {
    requestedBy = 'user-1';
    deletedFilters = {};

    const models = {
      '../models/User': {
        async findByIdAndRemove(id) {
          deletedFilters.user = id;
          return { id, email: 'care@example.test' };
        }
      },
      '../models/Settings': {
        async findOneAndDelete(filter) {
          deletedFilters.settings = filter;
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
      communicationAiTokenQuotaService: {
        async deleteUserQuota(input) {
          deletedFilters.aiTokenQuota = input;
          return true;
        }
      }
    };
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
  });

  it('rejects a different non-admin user before deleting anything', async function() {
    requestedBy = 'user-2';
    const res = createResponse();

    await controller.removeAccount(createRequest(), res);

    expect(res.statusCode).to.equal(401);
    expect(deletedFilters).to.deep.equal({});
  });
});

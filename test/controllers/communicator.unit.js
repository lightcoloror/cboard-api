'use strict';

process.env.NODE_ENV = 'test';

const chai = require('chai');
const mockery = require('mockery');
const YAML = require('yamljs');
const CommunicatorModel = require('../../api/models/Communicator');

const expect = chai.expect;

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

function createRequest(body, idempotencyKey) {
  return {
    body,
    user: { email: body.email },
    get(name) {
      return name === 'Idempotency-Key' ? idempotencyKey : undefined;
    }
  };
}

function createCommunicatorData(overrides = {}) {
  return {
    name: 'My communicator',
    author: 'Test user',
    email: 'user@example.com',
    description: 'Test communicator',
    rootBoard: 'root-board',
    boards: ['root-board'],
    defaultBoardsIncluded: [],
    ...overrides
  };
}

describe('Communicator create idempotency', function() {
  let controller;
  let persisted;
  let saveError;
  let findCallCount;
  let findOverride;
  let MockCommunicator;

  beforeEach(function() {
    persisted = [];
    saveError = null;
    findCallCount = 0;
    findOverride = null;

    MockCommunicator = class {
      constructor(data) {
        Object.assign(this, data);
        this._id = `communicator-${persisted.length + 1}`;
        this.lastEdited = '2026-07-21T00:00:00.000Z';
      }

      async save() {
        if (saveError) throw saveError;
        persisted.push(this);
        return this;
      }

      static findOne(query) {
        findCallCount += 1;
        return {
          exec: async () => {
            if (findOverride) return findOverride(query, findCallCount);
            return (
              persisted.find(
                communicator =>
                  communicator.email === query.email &&
                  communicator.clientCreationKey === query.clientCreationKey
              ) || null
            );
          }
        };
      }
    };

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('../models/Communicator', MockCommunicator);
    controller = require('../../api/controllers/communicator');
  });

  afterEach(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  it('replays a create request with the same authenticated key', async function() {
    const body = createCommunicatorData();
    const firstResponse = createResponse();
    const replayResponse = createResponse();

    await controller.createCommunicator(
      createRequest(body, 'local-communicator-1'),
      firstResponse
    );
    await controller.createCommunicator(
      createRequest(body, 'local-communicator-1'),
      replayResponse
    );

    expect(firstResponse.statusCode).to.equal(200);
    expect(replayResponse.statusCode).to.equal(200);
    expect(replayResponse.body.id).to.equal(firstResponse.body.id);
    expect(persisted).to.have.length(1);
    expect(replayResponse.body.communicator).not.to.have.property(
      'clientCreationKey'
    );
  });

  it('keeps different client keys as separate communicators', async function() {
    const body = createCommunicatorData();

    await controller.createCommunicator(
      createRequest(body, 'local-communicator-1'),
      createResponse()
    );
    await controller.createCommunicator(
      createRequest(body, 'local-communicator-2'),
      createResponse()
    );

    expect(persisted).to.have.length(2);
  });

  it('recovers the winning communicator after a duplicate-key race', async function() {
    const body = createCommunicatorData();
    const winner = new MockCommunicator({
      ...body,
      clientCreationKey: 'local-race'
    });
    winner._id = 'communicator-winner';
    saveError = Object.assign(new Error('duplicate key'), { code: 11000 });
    findOverride = (query, callCount) => (callCount === 1 ? null : winner);
    const response = createResponse();

    await controller.createCommunicator(
      createRequest(body, 'local-race'),
      response
    );

    expect(response.statusCode).to.equal(200);
    expect(response.body.id).to.equal('communicator-winner');
    expect(findCallCount).to.equal(2);
  });

  it('rejects malformed keys before touching persistence', async function() {
    const response = createResponse();

    await controller.createCommunicator(
      createRequest(createCommunicatorData(), 'contains spaces'),
      response
    );

    expect(response.statusCode).to.equal(400);
    expect(persisted).to.have.length(0);
    expect(findCallCount).to.equal(0);
  });

  it('binds an idempotent request to the authenticated email', async function() {
    const body = createCommunicatorData();
    const request = createRequest(body, 'local-communicator-1');
    request.user.email = 'another-user@example.com';
    const response = createResponse();

    await controller.createCommunicator(request, response);

    expect(response.statusCode).to.equal(200);
    expect(persisted).to.have.length(1);
    expect(persisted[0].email).to.equal('another-user@example.com');
    expect(body.email).to.equal('user@example.com');
  });

  it('lets an admin create an idempotent communicator for another user', async function() {
    const body = createCommunicatorData();
    const request = createRequest(body, 'managed-communicator-1');
    request.user = { email: 'admin@example.com', isAdmin: true };
    const response = createResponse();

    await controller.createCommunicator(request, response);

    expect(response.statusCode).to.equal(200);
    expect(persisted).to.have.length(1);
    expect(persisted[0].email).to.equal('user@example.com');
  });

  it('binds a legacy no-key request to the authenticated email', async function() {
    const body = createCommunicatorData();
    const request = createRequest(body);
    request.user.email = 'another-user@example.com';
    const response = createResponse();

    await controller.createCommunicator(request, response);

    expect(response.statusCode).to.equal(200);
    expect(persisted).to.have.length(1);
    expect(persisted[0].email).to.equal('another-user@example.com');
    expect(body.email).to.equal('user@example.com');
  });

  it('keeps legacy no-key requests independent', async function() {
    const body = createCommunicatorData();

    await controller.createCommunicator(createRequest(body), createResponse());
    await controller.createCommunicator(createRequest(body), createResponse());

    expect(persisted).to.have.length(2);
    expect(findCallCount).to.equal(0);
  });
});

describe('Communicator resource ownership', function() {
  let controller;
  let findQuery;
  let foundCommunicator;
  let paginationOptions;
  let MockCommunicator;

  beforeEach(function() {
    findQuery = null;
    foundCommunicator = null;
    paginationOptions = null;

    MockCommunicator = class {
      constructor(data) {
        Object.assign(this, data);
        this._id = data._id || 'communicator-1';
      }

      async save() {
        return this;
      }

      static findOne(query, callback) {
        findQuery = query;
        if (callback) {
          callback(null, foundCommunicator);
          return undefined;
        }
        return {
          exec: async () => foundCommunicator
        };
      }
    };

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('../models/Communicator', MockCommunicator);
    mockery.registerMock('../helpers/response', {
      async paginatedResponse(model, options) {
        paginationOptions = options;
        return { total: 0, data: [] };
      }
    });
    controller = require('../../api/controllers/communicator');
  });

  afterEach(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  function createOwnedRequest({
    body = {},
    email = 'owner@example.com',
    id = 'communicator-1',
    isAdmin = false,
    query = {}
  } = {}) {
    return {
      body,
      query,
      user: { email, isAdmin },
      swagger: { params: { id: { value: id } } }
    };
  }

  it('limits a regular user communicator list to their email', async function() {
    const res = createResponse();

    await controller.listCommunicators(createOwnedRequest(), res);

    expect(res.statusCode).to.equal(200);
    expect(paginationOptions.query).to.deep.equal({
      email: 'owner@example.com'
    });
  });

  it('keeps the full communicator list available to admins', async function() {
    const res = createResponse();

    await controller.listCommunicators(
      createOwnedRequest({ email: 'admin@example.com', isAdmin: true }),
      res
    );

    expect(res.statusCode).to.equal(200);
    expect(paginationOptions.query).to.deep.equal({});
  });

  it('loads a regular user communicator through an owner-filtered query', function() {
    foundCommunicator = new MockCommunicator({
      email: 'owner@example.com',
      rootBoard: 'root',
      boards: ['root']
    });
    const res = createResponse();

    controller.getCommunicator(createOwnedRequest(), res);

    expect(findQuery).to.deep.equal({
      _id: 'communicator-1',
      email: 'owner@example.com'
    });
    expect(res.statusCode).to.equal(200);
  });

  it('returns 404 when a regular user does not own the communicator', function() {
    const res = createResponse();

    controller.getCommunicator(createOwnedRequest(), res);

    expect(findQuery).to.deep.equal({
      _id: 'communicator-1',
      email: 'owner@example.com'
    });
    expect(res.statusCode).to.equal(404);
  });

  it('updates only the owner and ignores protected fields', async function() {
    foundCommunicator = new MockCommunicator({
      name: 'Old communicator',
      email: 'owner@example.com',
      rootBoard: 'root',
      boards: ['root']
    });
    const res = createResponse();

    await controller.updateCommunicator(
      createOwnedRequest({
        body: {
          name: 'Updated communicator',
          email: 'another-user@example.com',
          rootBoard: 'root',
          boards: ['root'],
          id: 'forged-id',
          _id: 'forged-id',
          __v: 999,
          clientCreationKey: 'forged-key',
          createdAt: 'forged-created',
          lastEdited: 'forged-edited'
        }
      }),
      res
    );

    expect(findQuery).to.deep.equal({
      _id: 'communicator-1',
      email: 'owner@example.com'
    });
    expect(res.statusCode).to.equal(200);
    expect(foundCommunicator.name).to.equal('Updated communicator');
    expect(foundCommunicator.email).to.equal('owner@example.com');
    expect(foundCommunicator._id).to.equal('communicator-1');
    expect(foundCommunicator).not.to.have.property('id');
    expect(foundCommunicator).not.to.have.property('__v');
    expect(foundCommunicator).not.to.have.property('clientCreationKey');
    expect(foundCommunicator).not.to.have.property('createdAt');
    expect(foundCommunicator).not.to.have.property('lastEdited');
  });

  it('returns 404 when a regular user does not own the update target', async function() {
    const res = createResponse();

    await controller.updateCommunicator(
      createOwnedRequest({
        body: { rootBoard: 'root', boards: ['root'] }
      }),
      res
    );

    expect(findQuery).to.deep.equal({
      _id: 'communicator-1',
      email: 'owner@example.com'
    });
    expect(res.statusCode).to.equal(404);
  });

  it('keeps cross-user read and ownership transfer available to admins', async function() {
    foundCommunicator = new MockCommunicator({
      email: 'old-owner@example.com',
      rootBoard: 'root',
      boards: ['root']
    });
    const request = createOwnedRequest({
      body: {
        email: 'new-owner@example.com',
        rootBoard: 'root',
        boards: ['root']
      },
      email: 'admin@example.com',
      isAdmin: true
    });
    const getResponse = createResponse();
    const updateResponse = createResponse();

    controller.getCommunicator(request, getResponse);
    expect(findQuery).to.deep.equal({ _id: 'communicator-1' });
    expect(getResponse.statusCode).to.equal(200);

    await controller.updateCommunicator(request, updateResponse);
    expect(findQuery).to.deep.equal({ _id: 'communicator-1' });
    expect(updateResponse.statusCode).to.equal(200);
    expect(foundCommunicator.email).to.equal('new-owner@example.com');
  });
});

describe('Communicator idempotency contract', function() {
  it('uses a partial unique index that ignores legacy communicators', function() {
    const index = CommunicatorModel.schema
      .indexes()
      .find(item => item[0].email === 1 && item[0].clientCreationKey === 1);

    expect(index).not.to.equal(undefined);
    expect(index[1].unique).to.equal(true);
    expect(index[1].partialFilterExpression).to.deep.equal({
      clientCreationKey: { $type: 'string' }
    });
  });

  it('documents the optional Idempotency-Key request header', function() {
    const swagger = YAML.load('./api/swagger/swagger.yaml');
    const parameters = swagger.paths['/communicator'].post.parameters;

    expect(parameters).to.deep.include({
      $ref: '#/parameters/CommunicatorIdempotencyKey'
    });
    expect(swagger.parameters.CommunicatorIdempotencyKey).to.include({
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      maxLength: 64
    });
  });
});

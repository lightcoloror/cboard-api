'use strict';

process.env.NODE_ENV = 'test';

const chai = require('chai');
const mockery = require('mockery');

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

function createRequest({
  body = {},
  id = 'board-1',
  email = 'owner@example.com',
  isAdmin = false
} = {}) {
  return {
    body,
    user: { email, isAdmin },
    swagger: { params: { id: { value: id } } }
  };
}

describe('Board write ownership', function() {
  let controller;
  let constructedData;
  let deleteError;
  let deleteQuery;
  let deleteResult;
  let findQuery;
  let foundBoard;
  let MockBoard;
  let previousLifecycleFlag;
  let lifecycleMode;
  let lifecycleCalls;
  let lifecycleSession;
  let base64Present;
  let imageUploads;

  beforeEach(function() {
    constructedData = null;
    deleteError = null;
    deleteQuery = null;
    deleteResult = null;
    findQuery = null;
    foundBoard = null;
    previousLifecycleFlag = process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    lifecycleMode = 'off';
    lifecycleCalls = [];
    lifecycleSession = { id: 'board-session' };
    base64Present = false;
    imageUploads = 0;

    MockBoard = class {
      constructor(data) {
        constructedData = { ...data };
        Object.assign(this, data);
        this._id = 'board-1';
      }

      save(callback) {
        this.saveOptions = arguments[0];
        if (typeof callback === 'function') callback(null, this);
        return Promise.resolve(this);
      }

      toJSON() {
        const { _id, ...data } = this;
        return { ...data, id: _id };
      }

      static findOne(query) {
        findQuery = query;
        return {
          session(value) {
            this.sessionValue = value;
            return this;
          },
          exec: async () => {
            if (query.email && foundBoard && foundBoard.email !== query.email) return null;
            return foundBoard;
          },
          then(resolve, reject) {
            return this.exec().then(resolve, reject);
          }
        };
      }

      static findOneAndDelete(query) {
        deleteQuery = query;
        return {
          session(value) {
            this.sessionValue = value;
            return this;
          },
          async exec() {
            if (!foundBoard || foundBoard.email !== query.email) return null;
            const deleted = foundBoard;
            foundBoard = null;
            return deleted;
          }
        };
      }

      static findOneAndRemove(query, callback) {
        deleteQuery = query;
        callback(deleteError, deleteResult);
      }
    };

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('../models/Board', MockBoard);
    mockery.registerMock('../helpers/imageProcessor', {
      hasBase64Images() {
        return base64Present;
      },
      async processBase64Images(tiles) {
        imageUploads += 1;
        return { tiles };
      }
    });
    mockery.registerMock('../helpers/legacyAccountWrite', {
      async withLegacyAccountWrite(actorId, ownerEmails, callback) {
        lifecycleCalls.push({ actorId, ownerEmails });
        if (lifecycleMode === 'closing' || (lifecycleMode === 'upload-close' && lifecycleCalls.length > 1)) {
          throw Object.assign(new Error('closing'), {
            code: 'ACCOUNT_CLOSING',
            status: 409
          });
        }
        const result = await callback(
          lifecycleMode === 'open' || lifecycleMode === 'upload-close'
            ? lifecycleSession
            : null
        );
        if (lifecycleMode === 'commit-fail') throw new Error('commit failed');
        return result;
      }
    });
    mockery.registerMock('../mail', { nev: {} });
    controller = require('../../api/controllers/board');
  });

  afterEach(function() {
    if (previousLifecycleFlag === undefined) delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    else process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = previousLifecycleFlag;
    mockery.deregisterAll();
    mockery.disable();
  });

  it('assigns a regular user board to the authenticated email', async function() {
    const body = {
      name: 'Board',
      email: 'another-user@example.com',
      tiles: []
    };
    const res = createResponse();

    await controller.createBoard(createRequest({ body }), res);

    expect(res.statusCode).to.equal(200);
    expect(constructedData.email).to.equal('owner@example.com');
    expect(body.email).to.equal('another-user@example.com');
  });

  it('lets an admin create a board for the requested user', async function() {
    const body = {
      name: 'Board',
      email: 'managed-user@example.com',
      tiles: []
    };

    await controller.createBoard(
      createRequest({ body, email: 'admin@example.com', isAdmin: true }),
      createResponse()
    );

    expect(constructedData.email).to.equal('managed-user@example.com');
  });

  it('loads a regular user update through an owner-filtered query', async function() {
    foundBoard = new MockBoard({
      name: 'Old board',
      email: 'owner@example.com',
      tiles: []
    });
    const res = createResponse();

    await controller.updateBoard(
      createRequest({
        body: {
          name: 'Updated board',
          email: 'another-user@example.com',
          _id: 'forged-id',
          id: 'forged-id',
          __v: 999,
          tiles: []
        }
      }),
      res
    );

    expect(findQuery).to.deep.equal({
      _id: 'board-1',
      email: 'owner@example.com'
    });
    expect(res.statusCode).to.equal(200);
    expect(foundBoard.name).to.equal('Updated board');
    expect(foundBoard.email).to.equal('owner@example.com');
    expect(foundBoard._id).to.equal('board-1');
    expect(foundBoard).not.to.have.property('id');
    expect(foundBoard).not.to.have.property('__v');
  });

  it('returns 404 when a regular user does not own the update target', async function() {
    const res = createResponse();

    await controller.updateBoard(
      createRequest({ body: { name: 'No access' } }),
      res
    );

    expect(findQuery).to.deep.equal({
      _id: 'board-1',
      email: 'owner@example.com'
    });
    expect(res.statusCode).to.equal(404);
  });

  it('keeps cross-user update capability for admins', async function() {
    foundBoard = new MockBoard({
      name: 'Managed board',
      email: 'old-owner@example.com',
      tiles: []
    });
    const res = createResponse();

    await controller.updateBoard(
      createRequest({
        body: { email: 'new-owner@example.com' },
        email: 'admin@example.com',
        isAdmin: true
      }),
      res
    );

    expect(findQuery).to.deep.equal({ _id: 'board-1' });
    expect(res.statusCode).to.equal(200);
    expect(foundBoard.email).to.equal('new-owner@example.com');
  });

  it('deletes a regular user board through an owner-filtered query', function() {
    deleteResult = { id: 'board-1', email: 'owner@example.com' };
    const res = createResponse();

    controller.deleteBoard(createRequest(), res);

    expect(deleteQuery).to.deep.equal({
      _id: 'board-1',
      email: 'owner@example.com'
    });
    expect(res.statusCode).to.equal(200);
  });

  it('returns 404 when no board matches the caller ownership', function() {
    const res = createResponse();

    controller.deleteBoard(createRequest(), res);

    expect(deleteQuery).to.deep.equal({
      _id: 'board-1',
      email: 'owner@example.com'
    });
    expect(res.statusCode).to.equal(404);
  });

  it('lets an admin delete a board without an owner filter', function() {
    deleteResult = { id: 'board-1', email: 'managed-user@example.com' };
    const res = createResponse();

    controller.deleteBoard(
      createRequest({ email: 'admin@example.com', isAdmin: true }),
      res
    );

    expect(deleteQuery).to.deep.equal({ _id: 'board-1' });
    expect(res.statusCode).to.equal(200);
  });

  it('creates with the account session and responds after the gated write', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    lifecycleMode = 'open';
    const request = createRequest({
      body: { name: 'Board', email: 'owner@example.com', tiles: [] },
      id: 'board-1'
    });
    request.user.id = 'actor-1';
    const response = createResponse();

    await controller.createBoard(request, response);

    expect(response.statusCode).to.equal(200);
    expect(lifecycleCalls[0]).to.deep.equal({
      actorId: 'actor-1',
      ownerEmails: ['owner@example.com']
    });
    expect(constructedData.email).to.equal('owner@example.com');
  });

  it('updates with a session after rereading the board owner', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    lifecycleMode = 'open';
    foundBoard = new MockBoard({
      name: 'Old board',
      email: 'old-owner@example.com',
      tiles: []
    });
    const request = createRequest({
      body: {
        name: 'Updated board',
        email: 'new-owner@example.com',
        tiles: []
      },
      email: 'admin@example.com',
      isAdmin: true
    });
    request.user.id = 'actor-1';
    const response = createResponse();

    await controller.updateBoard(request, response);

    expect(response.statusCode).to.equal(200);
    expect(lifecycleCalls[0].ownerEmails).to.deep.equal([
      'old-owner@example.com',
      'new-owner@example.com'
    ]);
    expect(foundBoard.saveOptions).to.deep.equal({ session: lifecycleSession });
  });

  it('rejects an image update if the account closes after upload and before save', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    lifecycleMode = 'upload-close';
    base64Present = true;
    foundBoard = new MockBoard({
      name: 'Board',
      email: 'owner@example.com',
      tiles: []
    });
    const request = createRequest({
      body: { tiles: [{ image: 'data:image/png;base64,abc' }] }
    });
    request.user.id = 'actor-1';
    const response = createResponse();

    await controller.updateBoard(request, response);

    expect(imageUploads).to.equal(1);
    expect(response.statusCode).to.equal(409);
    expect(response.body.error.code).to.equal('ACCOUNT_CLOSING');
    expect(foundBoard.saveOptions).to.equal(undefined);
  });

  it('deletes through a session-bound _id and original owner filter', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    lifecycleMode = 'open';
    foundBoard = new MockBoard({
      email: 'owner@example.com',
      tiles: []
    });
    const request = createRequest({
      email: 'admin@example.com',
      isAdmin: true
    });
    request.user.id = 'actor-1';
    const response = createResponse();

    await controller.deleteBoard(request, response);

    expect(response.statusCode).to.equal(200);
    expect(deleteQuery).to.deep.equal({
      _id: 'board-1',
      email: 'owner@example.com'
    });
  });

  it('does not return success when a gated create commit fails', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    lifecycleMode = 'commit-fail';
    const request = createRequest({
      body: { name: 'Board', email: 'owner@example.com', tiles: [] }
    });
    request.user.id = 'actor-1';
    const response = createResponse();

    await controller.createBoard(request, response);

    expect(response.statusCode).to.equal(409);
    expect(response.body).not.to.have.property('id');
  });

  it('does not let a non-owner update through the existing ownership filter', async function() {
    foundBoard = new MockBoard({
      email: 'different-owner@example.com',
      tiles: []
    });
    const response = createResponse();

    await controller.updateBoard(
      createRequest({ body: { name: 'No access' } }),
      response
    );

    expect(response.statusCode).to.equal(404);
  });
});

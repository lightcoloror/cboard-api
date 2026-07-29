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

  beforeEach(function() {
    constructedData = null;
    deleteError = null;
    deleteQuery = null;
    deleteResult = null;
    findQuery = null;
    foundBoard = null;

    MockBoard = class {
      constructor(data) {
        constructedData = { ...data };
        Object.assign(this, data);
        this._id = 'board-1';
      }

      save(callback) {
        if (callback) callback(null, this);
        return Promise.resolve(this);
      }

      toJSON() {
        const { _id, ...data } = this;
        return { ...data, id: _id };
      }

      static findOne(query) {
        findQuery = query;
        return Promise.resolve(foundBoard);
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
        return false;
      },
      processBase64Images() {
        throw new Error('Image processing should not run in ownership tests');
      }
    });
    mockery.registerMock('../mail', { nev: {} });
    controller = require('../../api/controllers/board');
  });

  afterEach(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  it('assigns a regular user board to the authenticated email', function() {
    const body = {
      name: 'Board',
      email: 'another-user@example.com',
      tiles: []
    };
    const res = createResponse();

    controller.createBoard(createRequest({ body }), res);

    expect(res.statusCode).to.equal(200);
    expect(constructedData.email).to.equal('owner@example.com');
    expect(body.email).to.equal('another-user@example.com');
  });

  it('lets an admin create a board for the requested user', function() {
    const body = {
      name: 'Board',
      email: 'managed-user@example.com',
      tiles: []
    };

    controller.createBoard(
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
});

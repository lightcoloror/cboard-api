'use strict';

process.env.NODE_ENV = 'test';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('Health controller', function() {
  let database;
  let controller;
  let communicationIndexes;
  let ensureCalls;
  let storageConfigured;

  beforeEach(function() {
    database = { readyState: 1 };
    communicationIndexes = 'ready';
    ensureCalls = 0;
    storageConfigured = true;
    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('../../db', database);
    mockery.registerMock('../helpers/communicationIndexes', {
      COMMUNICATION_INDEX_STATUSES: {
        BUILDING: 'building',
        READY: 'ready'
      },
      ensureCommunicationIndexes: async () => {
        ensureCalls += 1;
      },
      getCommunicationIndexesStatus: () => communicationIndexes
    });
    mockery.registerMock('../helpers/blob', {
      isBlobStorageConfigured: () => storageConfigured
    });
    controller = require('../../api/controllers/health');
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

  it('reports ready only when MongoDB is connected', function() {
    const res = createResponse();

    controller.getHealth({}, res);

    expect(res.statusCode).to.equal(200);
    expect(res.body).to.deep.equal({
      status: 'ok',
      database: 'connected',
      communicationIndexes: 'ready',
      privatePictureLibrary: 'configured'
    });
    expect(ensureCalls).to.equal(0);
  });

  it('reports degraded while MongoDB is unavailable', function() {
    database.readyState = 0;
    const res = createResponse();

    controller.getHealth({}, res);

    expect(res.statusCode).to.equal(503);
    expect(res.body).to.deep.equal({
      status: 'degraded',
      database: 'disconnected',
      communicationIndexes: 'ready',
      privatePictureLibrary: 'configured'
    });
    expect(ensureCalls).to.equal(0);
  });

  it('stays degraded and retries when required indexes failed', function() {
    communicationIndexes = 'failed';
    const res = createResponse();

    controller.getHealth({}, res);

    expect(res.statusCode).to.equal(503);
    expect(res.body).to.deep.equal({
      status: 'degraded',
      database: 'connected',
      communicationIndexes: 'failed',
      privatePictureLibrary: 'configured'
    });
    expect(ensureCalls).to.equal(1);
  });

  it('does not start another index build while one is active', function() {
    communicationIndexes = 'building';
    const res = createResponse();

    controller.getHealth({}, res);

    expect(res.statusCode).to.equal(503);
    expect(ensureCalls).to.equal(0);
  });

  it('reports optional private storage without degrading the core API', function() {
    storageConfigured = false;
    const res = createResponse();

    controller.getHealth({}, res);

    expect(res.statusCode).to.equal(200);
    expect(res.body.privatePictureLibrary).to.equal('unconfigured');
    expect(res.body.status).to.equal('ok');
  });
});

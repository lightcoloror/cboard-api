'use strict';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;
const entryPath = require.resolve('../../scripts/runCareClosureWorker');

function expectCode(promise, code) {
  return promise.then(
    () => { throw new Error(`expected ${code}`); },
    error => expect(error.code).to.equal(code)
  );
}

function harness({ readyState = 0, connectError = null, batchResult = { processed: 1 } } = {}) {
  const calls = {
    connect: [], disconnect: 0, runBatch: 0, quota: [], runtime: null,
    worker: null, cleanup: [], revoked: []
  };
  const connection = { readyState };
  const mongoose = {
    connection,
    async connect(uri, options) {
      calls.connect.push({ uri, options });
      if (connectError) throw connectError;
      connection.readyState = 1;
    },
    async disconnect() {
      calls.disconnect += 1;
      connection.readyState = 0;
    }
  };
  const quotaService = { marker: 'quota-service' };
  mockery.registerMock('mongoose', mongoose);
  mockery.registerMock('../api/helpers/communicationAiTokenQuota', {
    createCommunicationAiTokenQuotaService(options) {
      calls.quota.push(options);
      return quotaService;
    }
  });
  mockery.registerMock('../api/helpers/careRuntime', {
    getMediaAdapter() { return { marker: 'media-adapter' }; }
  });
  mockery.registerMock('../api/helpers/deviceSessions', {
    revoke(owner) { calls.revoked.push(owner); return `revoked:${owner}`; }
  });
  mockery.registerMock('../api/controllers/account', {
    async cleanupAccountData(args) {
      calls.cleanup.push(args);
      return { cleaned: true };
    }
  });
  mockery.registerMock('../api/helpers/careClosureRuntime', {
    createCareClosureRuntime(options) {
      calls.runtime = options;
      return { runner: { marker: 'runner' } };
    }
  });
  mockery.registerMock('../api/helpers/careClosureWorker', {
    createCareClosureWorker(options) {
      calls.worker = options;
      return { async runBatch() { calls.runBatch += 1; return batchResult; } };
    }
  });
  delete require.cache[entryPath];
  const { main } = require(entryPath);
  return { main, calls, connection, quotaService };
}

describe('care closure worker entry safety', function() {
  beforeEach(function() {
    mockery.enable({ warnOnReplace: false, warnOnUnregistered: false, useCleanCache: true });
  });

  afterEach(function() {
    mockery.deregisterAll();
    mockery.disable();
    delete require.cache[entryPath];
  });

  it('requires all three worker feature flags before loading Mongo', async function() {
    for (const missing of ['CARE_COLLABORATION_ENABLED', 'CARE_LIFECYCLE_TRANSACTIONS_ENABLED', 'CARE_CLOSURE_WORKER_ENABLED']) {
      const h = harness();
      const env = {
        CARE_COLLABORATION_ENABLED: 'true',
        CARE_LIFECYCLE_TRANSACTIONS_ENABLED: 'true',
        CARE_CLOSURE_WORKER_ENABLED: 'true'
      };
      delete env[missing];
      await expectCode(h.main({ env }), 'CLOSURE_WORKER_DISABLED');
      expect(h.calls.connect).to.have.length(0);
    }
  });

  it('requires an explicit Mongo URI and never falls back to application db.js', async function() {
    const h = harness();
    const env = {
      CARE_COLLABORATION_ENABLED: 'true',
      CARE_LIFECYCLE_TRANSACTIONS_ENABLED: 'true',
      CARE_CLOSURE_WORKER_ENABLED: 'true'
    };
    await expectCode(h.main({ env }), 'CLOSURE_WORKER_DATABASE_REQUIRED');
    expect(h.calls.connect).to.have.length(0);
  });

  it('rejects an already-used mongoose connection', async function() {
    const h = harness({ readyState: 1 });
    await expectCode(h.main({ env: {
      CARE_COLLABORATION_ENABLED: 'true', CARE_LIFECYCLE_TRANSACTIONS_ENABLED: 'true',
      CARE_CLOSURE_WORKER_ENABLED: 'true', CARE_CLOSURE_MONGO_URI: 'mongodb://localhost/closure'
    } }), 'CLOSURE_WORKER_CONNECTION_IN_USE');
    expect(h.calls.connect).to.have.length(0);
    expect(h.calls.disconnect).to.equal(0);
  });

  it('disconnects after connection failure', async function() {
    const h = harness({ connectError: Object.assign(new Error('private connection details'), { code: 'ECONNREFUSED' }) });
    await expectCode(h.main({ env: {
      CARE_COLLABORATION_ENABLED: 'true', CARE_LIFECYCLE_TRANSACTIONS_ENABLED: 'true',
      CARE_CLOSURE_WORKER_ENABLED: 'true', CARE_CLOSURE_MONGO_URI: 'mongodb://localhost/closure'
    } }), 'ECONNREFUSED');
    expect(h.calls.connect).to.have.length(1);
    expect(h.calls.disconnect).to.equal(1);
  });

  it('runs exactly one batch with the dedicated connection and assembled cleanup adapters', async function() {
    const h = harness({ batchResult: { processed: 2 } });
    const result = await h.main({ env: {
      CARE_COLLABORATION_ENABLED: 'true', CARE_LIFECYCLE_TRANSACTIONS_ENABLED: 'true',
      CARE_CLOSURE_WORKER_ENABLED: 'true', CARE_CLOSURE_MONGO_URI: 'mongodb://localhost/closure'
    } });

    expect(result).to.deep.equal({ processed: 2 });
    expect(h.calls.connect).to.have.length(1);
    expect(h.calls.connect[0].uri).to.equal('mongodb://localhost/closure');
    expect(h.calls.quota[0].storeClient).to.equal(h.connection);
    expect(h.calls.runtime.connection).to.equal(h.connection);
    expect(h.calls.runtime.media).to.deep.equal({ marker: 'media-adapter' });
    expect(h.calls.worker).to.deep.equal({ connection: h.connection, runner: { marker: 'runner' } });
    expect(h.calls.runBatch).to.equal(1);
    const cleanupResult = await h.calls.runtime.cleanup({ id: 'owner-1', userEmail: 'owner@example.test' });
    expect(cleanupResult).to.deep.equal({ cleaned: true });
    expect(h.calls.cleanup[0]).to.deep.equal({ id: 'owner-1', userEmail: 'owner@example.test', quotaService: h.quotaService });
    expect(h.calls.runtime.revokeSessions('owner-1')).to.equal('revoked:owner-1');
    expect(h.calls.revoked).to.deep.equal(['owner-1']);
    expect(h.calls.disconnect).to.equal(1);
  });
});

'use strict';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;
const entryPath = require.resolve('../../scripts/inspectCareClosureJob');

function expectCode(promise, code) {
  return promise.then(
    () => { throw new Error(`expected ${code}`); },
    error => expect(error.code).to.equal(code)
  );
}

function harness({ readyState = 0, connectError = null } = {}) {
  const calls = { connect: [], disconnect: 0, inspect: [] };
  const connection = { readyState };
  mockery.registerMock('mongoose', {
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
  });
  mockery.registerMock('../api/helpers/careClosureDiagnostics', {
    async inspectCareClosureJob(input) {
      calls.inspect.push(input);
      return { state: 'prepared', operationId: input.operationId };
    }
  });
  delete require.cache[entryPath];
  const { main } = require(entryPath);
  return { main, calls, connection };
}

const validEnv = {
  CARE_CLOSURE_MONGO_URI: 'mongodb://example.test/closure',
  CARE_CLOSURE_OPERATION_ID: 'closure_job-1'
};

describe('care closure inspection entry safety', function() {
  beforeEach(function() {
    mockery.enable({ warnOnReplace: false, warnOnUnregistered: false, useCleanCache: true });
  });

  afterEach(function() {
    mockery.deregisterAll();
    mockery.disable();
    delete require.cache[entryPath];
  });

  it('requires the explicit closure database URI before loading Mongo', async function() {
    const h = harness();
    await expectCode(h.main({ env: { CARE_CLOSURE_OPERATION_ID: 'closure_job-1' } }),
      'CLOSURE_INSPECT_DATABASE_REQUIRED');
    expect(h.calls.connect).to.have.length(0);
    expect(h.calls.disconnect).to.equal(0);
  });

  it('rejects missing, malformed, and prototype operation ids before connecting', async function() {
    for (const operationId of [undefined, '', 'has space', 'a/'.repeat(41), '__proto__', 'constructor', 'prototype']) {
      const h = harness();
      await expectCode(h.main({ env: { ...validEnv, CARE_CLOSURE_OPERATION_ID: operationId } }),
        operationId === undefined || operationId === ''
          ? 'CLOSURE_INSPECT_OPERATION_REQUIRED'
          : 'CLOSURE_INSPECT_OPERATION_INVALID');
      expect(h.calls.connect).to.have.length(0);
      expect(h.calls.disconnect).to.equal(0);
    }
  });

  it('rejects an already-used mongoose connection', async function() {
    const h = harness({ readyState: 1 });
    await expectCode(h.main({ env: validEnv }), 'CLOSURE_INSPECT_CONNECTION_IN_USE');
    expect(h.calls.connect).to.have.length(0);
    expect(h.calls.disconnect).to.equal(0);
  });

  it('uses a temporary dedicated connection, returns only the diagnostic result, and disconnects', async function() {
    const h = harness();
    const result = await h.main({ env: validEnv });
    expect(result).to.deep.equal({ state: 'prepared', operationId: 'closure_job-1' });
    expect(h.calls.connect).to.deep.equal([{
      uri: 'mongodb://example.test/closure',
      options: {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000
      }
    }]);
    expect(h.calls.inspect).to.deep.equal([{
      connection: h.connection,
      operationId: 'closure_job-1'
    }]);
    expect(h.calls.disconnect).to.equal(1);
  });

  it('disconnects when connection setup fails', async function() {
    const h = harness({ connectError: Object.assign(new Error('private failure'), { code: 'ECONNREFUSED' }) });
    await expectCode(h.main({ env: validEnv }), 'ECONNREFUSED');
    expect(h.calls.connect).to.have.length(1);
    expect(h.calls.inspect).to.have.length(0);
    expect(h.calls.disconnect).to.equal(1);
  });
});

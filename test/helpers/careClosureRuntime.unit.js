'use strict';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('care closure runtime composition', function() {
  let createRuntime;
  let originalMocks;

  beforeEach(function() {
    originalMocks = {};
    mockery.enable({ warnOnReplace: false, warnOnUnregistered: false, useCleanCache: true });
    const calls = [];
    const factory = name => options => {
      calls.push({ name, options });
      return { name, options, run: async () => ({ status: 'noop', count: 0 }) };
    };
    const coordinator = factory('coordinator');
    const receipt = factory('receipt');
    const finalize = factory('finalize');
    const runner = options => {
      calls.push({ name: 'runner', options });
      return { name: 'runner', options };
    };
    mockery.registerMock('./careClosureReceipt', { createCareClosureReceipt: receipt });
    mockery.registerMock('./careClosureCoordinator', { createCareClosureCoordinator: coordinator });
    mockery.registerMock('./careClosureMediaStep', { createCareClosureMediaStep: factory('media') });
    mockery.registerMock('./careClosureAccountStep', { createCareClosureAccountStep: factory('account') });
    mockery.registerMock('./careClosureDataStep', { createCareClosureDataStep: factory('data') });
    mockery.registerMock('./careClosureAccessStep', { createCareClosureAccessStep: factory('access') });
    mockery.registerMock('./careClosureFinalize', { createCareClosureFinalize: finalize });
    mockery.registerMock('./careClosureRunner', { createCareClosureRunner: runner });
    delete require.cache[require.resolve('../../api/helpers/careClosureRuntime')];
    createRuntime = require('../../api/helpers/careClosureRuntime').createCareClosureRuntime;
    originalMocks.calls = calls;
  });

  afterEach(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  it('wires one connection/encryption and all trusted adapters without running a stage', function() {
    const connection = { id: 'connection' };
    const encryption = { id: 'encryption' };
    const media = { remove: async () => {} };
    const cleanup = async () => {};
    const revokeSessions = async () => {};
    const now = () => 123;

    const runtime = createRuntime({ connection, encryption, media, cleanup, revokeSessions, now, maxPerRun: 7 });
    const calls = originalMocks.calls;

    expect(runtime).to.have.all.keys('receipt', 'coordinator', 'runner');
    expect(calls.map(call => call.name)).to.deep.equal([
      'receipt', 'coordinator', 'media', 'account', 'data', 'access', 'finalize', 'runner'
    ]);
    for (const call of calls.filter(call => ['media', 'account', 'data', 'access', 'finalize'].includes(call.name))) {
      expect(call.options.connection).to.equal(connection);
      expect(call.options.encryption).to.equal(encryption);
      expect(call.options.now).to.equal(now);
    }
    expect(calls.find(call => call.name === 'media').options.media).to.equal(media);
    expect(calls.find(call => call.name === 'finalize').options.cleanup).to.equal(cleanup);
    expect(calls.find(call => call.name === 'finalize').options.revokeSessions).to.equal(revokeSessions);
    expect(calls.find(call => call.name === 'media').options.maxPerRun).to.equal(7);
    expect(calls.find(call => call.name === 'account').options.maxPerRun).to.equal(7);
    expect(calls.find(call => call.name === 'access').options.maxPerRun).to.equal(7);
    expect(calls.find(call => call.name === 'runner').options.maxStages).to.equal(5);
  });

  it('passes the receipt to the coordinator and every stage to the runner', function() {
    const connection = {};
    const encryption = {};
    const runtime = createRuntime({
      connection,
      encryption,
      media: { remove: async () => {} },
      cleanup: async () => {},
      revokeSessions: async () => {}
    });
    const calls = originalMocks.calls;
    const coordinatorCall = calls.find(call => call.name === 'coordinator');
    const runnerCall = calls.find(call => call.name === 'runner');

    expect(coordinatorCall.options.receipt).to.equal(runtime.receipt);
    expect(runnerCall.options.coordinator).to.equal(runtime.coordinator);
    expect(runnerCall.options.mediaStep.name).to.equal('media');
    expect(runnerCall.options.accountStep.name).to.equal('account');
    expect(runnerCall.options.dataStep.name).to.equal('data');
    expect(runnerCall.options.accessStep.name).to.equal('access');
    expect(runnerCall.options.finalizeStep.name).to.equal('finalize');
  });

  it('requires trusted adapters before constructing any helper', function() {
    expect(() => createRuntime({ media: {}, cleanup: async () => {}, revokeSessions: async () => {} }))
      .to.throw('Media remove adapter is required');
    expect(() => createRuntime({ media: { remove: async () => {} }, revokeSessions: async () => {} }))
      .to.throw('Account cleanup adapters are required');
  });
});

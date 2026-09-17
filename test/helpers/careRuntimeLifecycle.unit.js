'use strict';
const assert = require('assert').strict;
const mockery = require('mockery');

describe('care runtime family creation lifecycle adapter', () => {
  let previous, calls, store, failure;
  beforeEach(() => {
    previous = process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    calls = []; failure = null;
    mockery.enable({ useCleanCache: true, warnOnUnregistered: false, warnOnReplace: false });
    mockery.registerMock('../models/CareWorkspace', { Family: { create: async value => { calls.push('legacy'); return value; } }, Profile: {}, Account: {} });
    mockery.registerMock('./careFamilyLifecycle', { createCareFamilyLifecycle: () => ({ createFamily: async value => {
      calls.push('transaction');
      if (failure) throw failure;
      return value;
    } }) });
    mockery.registerMock('./blob', {});
    store = require('../../api/helpers/careRuntime').store;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    else process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = previous;
    mockery.deregisterAll(); mockery.disable();
  });
  it('preserves the current creation path until explicitly enabled', async () => {
    delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    await store.createFamily({ _id: 'family-a', owner: 'owner-a' });
    assert.deepEqual(calls, ['legacy']);
  });
  it('uses the account transaction boundary when enabled', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    const value = { _id: 'family-a', owner: 'owner-a' };
    assert.deepEqual(await store.createFamily(value), value);
    assert.deepEqual(calls, ['transaction']);
  });
  it('does not fall back to an unfenced insert after a transaction error', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    failure = new Error('Transactions unavailable');
    await assert.rejects(store.createFamily({ _id: 'family-a', owner: 'owner-a' }), /Transactions unavailable/);
    assert.deepEqual(calls, ['transaction']);
  });
});

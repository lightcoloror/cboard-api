'use strict';
const assert = require('assert').strict;
const mockery = require('mockery');

describe('care runtime lifecycle adapter', () => {
  let previous, calls, store, failure;
  beforeEach(() => {
    previous = process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    calls = []; failure = null;
    mockery.enable({ useCleanCache: true, warnOnUnregistered: false, warnOnReplace: false });
    mockery.registerMock('../models/CareWorkspace', { Family: { create: async value => { calls.push('legacy'); return value; } },
      Profile: { updateOne: (filter, update) => ({ exec: async () => { calls.push({ legacyProfile: true, filter, update }); return { nModified: 1 }; } }) }, Account: {} });
    mockery.registerMock('./careFamilyLifecycle', { createCareFamilyLifecycle: () => ({ createFamily: async value => {
      calls.push('transaction');
      if (failure) throw failure;
      return value;
    }, casFamily: async (id, rev, value) => {
      calls.push({ id, rev, value });
      if (failure) throw failure;
      return false;
    }, casProfile: async (id, rev, value, context) => {
      calls.push({ profile: true, id, rev, value, context });
      if (failure) throw failure;
      return false;
    }, createProfile: async (value, communicator) => {
      calls.push({ createProfile: true, value, communicator });
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
  it('passes family CAS arguments and preserves stale-version results', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    const value = { owner: 'owner-b', rev: 2 };
    assert.equal(await store.casFamily('family-a', 1, value), false);
    assert.deepEqual(calls, [{ id: 'family-a', rev: 1, value }]);
  });
  it('does not fall back to a legacy update after a family fence error', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    failure = new Error('ACCOUNT_CLOSING');
    await assert.rejects(store.casFamily('family-a', 1, { rev: 2 }), /ACCOUNT_CLOSING/);
    assert.equal(calls.length, 1);
  });
  it('preserves the legacy profile path before explicit enablement', async () => {
    delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    const value = { rev: 2, sealed: { synthetic: true } };
    assert.equal(await store.casProfile('profile-a', 1, value), true);
    assert.deepEqual(calls, [{ legacyProfile: true, filter: { _id: 'profile-a', rev: 1 }, update: { $set: value } }]);
  });
  it('routes profile updates through the transaction and preserves stale-version results', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    const value = { rev: 2, sealed: { synthetic: true } };
    const context = { expectedOwner: 'owner-a' };
    assert.equal(await store.casProfile('profile-a', 1, value, context), false);
    assert.deepEqual(calls, [{ profile: true, id: 'profile-a', rev: 1, value, context }]);
  });
  it('never falls back to a legacy profile write after closure rejection', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    failure = new Error('FAMILY_CLOSING');
    await assert.rejects(store.casProfile('profile-a', 1, { rev: 2 }), /FAMILY_CLOSING/);
    assert.equal(calls.length, 1);
  });
  it('constructs a content-free communicator for atomic profile creation', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    const value = { _id: 'profile-a', familyId: 'family-a', owner: 'owner-a', rev: 0, sealed: { synthetic: true } };
    assert.deepEqual(await store.createProfileWithCommunicator(value), value);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].communicator.careProfileId, value._id);
    assert.equal(calls[0].communicator.careFamilyId, value.familyId);
    assert.equal(calls[0].communicator.sealed, undefined);
    assert.deepEqual(calls[0].communicator.boards, []);
  });
  it('does not use separate inserts after atomic profile creation fails', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    failure = new Error('FAMILY_CLOSING');
    store.createCommunicator = async () => { throw new Error('unexpected fallback'); };
    store.createProfile = async () => { throw new Error('unexpected fallback'); };
    await assert.rejects(store.createProfileWithCommunicator({ _id: 'profile-a', familyId: 'family-a' }), /FAMILY_CLOSING/);
    assert.equal(calls.length, 1);
  });
});

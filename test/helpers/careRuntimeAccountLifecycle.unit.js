'use strict';

const assert = require('assert').strict;
const mockery = require('mockery');

describe('care runtime account lifecycle adapter', () => {
  let previous, calls, store, lifecycleError, account;

  beforeEach(() => {
    previous = process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    calls = [];
    lifecycleError = null;
    const accountCollection = {
      insertOne: async (value, options) => {
        calls.push({ op: 'insertOne', value, options });
        if (lifecycleError) throw lifecycleError;
        return {};
      },
      updateOne: async (filter, update, options) => {
        calls.push({ op: 'collectionUpdateOne', filter, update, options });
        if (lifecycleError) throw lifecycleError;
        return { matchedCount: 1 };
      }
    };
    account = {
      collection: accountCollection,
      create: async value => { calls.push({ op: 'legacyCreate', value }); return value; },
      updateOne: (filter, update) => ({ exec: async () => {
        calls.push({ op: 'legacyUpdateOne', filter, update });
        return { nModified: 1 };
      } })
    };
    mockery.enable({ useCleanCache: true, warnOnUnregistered: false, warnOnReplace: false });
    mockery.registerMock('../models/CareWorkspace', { Family: {}, Profile: {}, Account: account });
    mockery.registerMock('mongoose', { connection: { collection: () => ({ insertOne: async () => {} }) } });
    mockery.registerMock('./blob', {});
    mockery.registerMock('./careFamilyLifecycle', {
      createCareFamilyLifecycle: () => ({
        withOpenAccount: async (owner, callback) => {
          calls.push({ op: 'withOpenAccount', owner });
          if (lifecycleError) throw lifecycleError;
          try {
            return await callback({ id: 'session-1' });
          } catch (error) {
            calls.push({ op: 'lifecycleAbort', code: error.code });
            throw error;
          }
        }
      })
    });
    store = require('../../api/helpers/careRuntime').store;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    else process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = previous;
    mockery.deregisterAll();
    mockery.disable();
  });

  it('passes the lifecycle session to native account writes', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    const value = { _id: 'owner-a', rev: 0, sealed: { synthetic: true } };
    assert.equal(await store.createAccount(value), true);
    assert.equal(await store.casAccount('owner-a', 0, { rev: 1, sealed: { next: true } }), true);
    assert.deepEqual(calls, [
      { op: 'withOpenAccount', owner: 'owner-a' },
      { op: 'insertOne', value, options: { session: { id: 'session-1' } } },
      { op: 'withOpenAccount', owner: 'owner-a' },
      { op: 'collectionUpdateOne', filter: { _id: 'owner-a', rev: 0 }, update: { $set: { rev: 1, sealed: { next: true } } }, options: { session: { id: 'session-1' } } }
    ]);
  });

  it('preserves a false CAS result from the native matched count', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    const collectionUpdateOne = account.collection.updateOne;
    account.collection.updateOne = async (...args) => {
      calls.push({ op: 'collectionUpdateOne', filter: args[0], update: args[1], options: args[2] });
      return { matchedCount: 0 };
    };
    assert.equal(await store.casAccount('owner-a', 4, { rev: 5 }), false);
    assert.equal(calls.at(-1).op, 'collectionUpdateOne');
    account.collection.updateOne = collectionUpdateOne;
  });

  it('returns false for a duplicate account insert', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    account.collection.insertOne = async (value, options) => {
      calls.push({ op: 'insertOne', value, options });
      const error = new Error('duplicate'); error.code = 11000; throw error;
    };
    assert.equal(await store.createAccount({ _id: 'owner-a' }), false);
    assert.deepEqual(calls.at(-1), { op: 'lifecycleAbort', code: 11000 });
    assert.equal(calls.some(call => call.op === 'legacyCreate'), false);
  });

  it('propagates lifecycle closure errors without writing or falling back', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    lifecycleError = Object.assign(new Error('ACCOUNT_CLOSING'), { code: 'ACCOUNT_CLOSING' });
    await assert.rejects(store.createAccount({ _id: 'owner-a' }), /ACCOUNT_CLOSING/);
    await assert.rejects(store.casAccount('owner-a', 0, { rev: 1 }), /ACCOUNT_CLOSING/);
    assert.equal(calls.filter(call => call.op === 'legacyCreate' || call.op === 'legacyUpdateOne' || call.op === 'insertOne' || call.op === 'collectionUpdateOne').length, 0);
  });

  it('preserves the legacy account paths by default', async () => {
    delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    assert.equal(await store.createAccount({ _id: 'owner-a' }), true);
    assert.equal(await store.casAccount('owner-a', 0, { rev: 1 }), true);
    assert.deepEqual(calls.map(call => call.op), ['legacyCreate', 'legacyUpdateOne']);
  });
});

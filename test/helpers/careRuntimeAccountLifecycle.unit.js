'use strict';

const assert = require('assert').strict;
const mockery = require('mockery');

describe('care runtime account lifecycle adapter', () => {
  let previous, previousNext, calls, store, lifecycleError, account, familyExpired;

  beforeEach(() => {
    previous = process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    previousNext = process.env.CARE_NEXT_ENABLED;
    calls = [];
    lifecycleError = null;
    familyExpired = false;
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
    const profileState = { grants: { 'reader-a': ['read'] }, resources: {
      'favorite:shared-a': { version: 2, source: { owner: 'owner-a', id: 'favorite-a' } }
    } };
    const profile = {
      findById: () => ({ lean: () => ({ exec: async () => ({ _id: 'profile-a', familyId: 'family-a', sealed: profileState }) }) }),
      collection: { findOne: async (filter, options) => { calls.push({ op: 'profileFindOne', filter, options }); return { _id: 'profile-a', familyId: 'family-a', sealed: profileState }; } }
    };
    mockery.enable({ useCleanCache: true, warnOnUnregistered: false, warnOnReplace: false });
    mockery.registerMock('../models/CareWorkspace', { Family: {}, Profile: profile, Account: account });
    mockery.registerMock('mongoose', { connection: { collection: () => ({ insertOne: async () => {} }) } });
    mockery.registerMock('./blob', {});
    mockery.registerMock('./careCrypto', { fromEnvironment: () => ({ open: value => value }) });
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
        },
        withOpenFamilyAccounts: async (familyId, accountIds, callback) => {
          calls.push({ op: 'withOpenFamilyAccounts', familyId, accountIds });
          if (lifecycleError) throw lifecycleError;
          const family = { _id: familyId, owner: 'owner-a', sealed: { subscription: { startsAt: 1, expiresAt: familyExpired ? 1 : Date.now() + 100000 } } };
          try { return await callback({ id: 'session-1' }, family); }
          catch (error) { calls.push({ op: 'lifecycleAbort', code: error.code }); throw error; }
        }
      })
    });
    store = require('../../api/helpers/careRuntime').store;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    else process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = previous;
    if (previousNext === undefined) delete process.env.CARE_NEXT_ENABLED;
    else process.env.CARE_NEXT_ENABLED = previousNext;
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

  it('authorizes favorite CAS inside the family transaction and passes its session', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    assert.equal(await store.casAccount('owner-a', 0, { rev: 1 }, { mode: 'favorite', actor: 'owner-a', profileId: 'profile-a', resourceId: 'favorite-a' }), true);
    const tx = calls.find(call => call.op === 'withOpenFamilyAccounts');
    const write = calls.find(call => call.op === 'collectionUpdateOne');
    assert.deepEqual(tx.accountIds, ['owner-a', 'owner-a']);
    assert.deepEqual(write.options, { session: { id: 'session-1' } });
  });

  it('rejects impersonated favorite writes and shared source mismatches', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    await assert.rejects(store.casAccount('owner-a', 0, { rev: 1 }, { mode: 'favorite', actor: 'reader-a', profileId: 'profile-a', resourceId: 'favorite-a' , sharedId: 'shared-a', sharedVersion: 2 }), e => e.code === 'FAVORITE_SCOPE_DENIED');
    await assert.rejects(store.casAccount('owner-a', 0, { rev: 1 }, { mode: 'favorite', actor: 'owner-a', profileId: 'profile-a', resourceId: 'other', sharedId: 'shared-a', sharedVersion: 2 }), e => e.code === 'FAVORITE_SCOPE_DENIED');
    await assert.rejects(store.casAccount('owner-a', 0, { rev: 1 }, { mode: 'favorite', actor: 'owner-a', profileId: 'profile-a', resourceId: 'favorite-a', sharedId: 'shared-a', sharedVersion: 1 }), e => e.code === 'SHARED_FAVORITE_CHANGED');
    assert.equal(calls.some(call => call.op === 'collectionUpdateOne'), false);
  });

  it('enforces active sync-write entitlement for favorites when enabled', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    process.env.CARE_NEXT_ENABLED = 'true';
    familyExpired = true;
    await assert.rejects(store.casAccount('owner-a', 0, { rev: 1 }, { mode: 'favorite', actor: 'owner-a', profileId: 'profile-a', resourceId: 'favorite-a' }), e => e.code === 'SUBSCRIPTION_EXPIRED');
  });

  it('checks selected profiles in the family transaction before account CAS', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    assert.equal(await store.casAccount('reader-a', 0, { rev: 1 }, { mode: 'select-profile', profileId: 'profile-a' }), true);
    assert.deepEqual(calls.find(call => call.op === 'withOpenFamilyAccounts').accountIds, ['reader-a']);
    assert.deepEqual(calls.find(call => call.op === 'collectionUpdateOne').options, { session: { id: 'session-1' } });
  });

  it('rejects selected profile writes when the lifecycle transaction is closed', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    lifecycleError = Object.assign(new Error('FAMILY_CLOSING'), { code: 'FAMILY_CLOSING' });
    await assert.rejects(store.casAccount('reader-a', 0, { rev: 1 }, { mode: 'select-profile', profileId: 'profile-a' }), /FAMILY_CLOSING/);
    assert.equal(calls.some(call => call.op === 'collectionUpdateOne'), false);
  });
});

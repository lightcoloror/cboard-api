'use strict';

const assert = require('assert').strict;
const mockery = require('mockery');

describe('care budget runtime lifecycle adapter', () => {
  let previous, funding, profile, calls, current, lifecycleError, store;

  beforeEach(() => {
    previous = process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    calls = []; lifecycleError = null;
    current = { _id: 'funding-a', rev: 0, kind: 'family', owner: 'owner-a', familyId: 'family-a', sealed: { subscription: { startsAt: 1, expiresAt: Date.now() + 100000 } } };
    profile = { _id: 'profile-a', familyId: 'family-a', sealed: { grants: { 'reader-a': ['read'] }, deleted: false } };
    const find = () => ({ lean: () => ({ exec: async () => current && { ...current } }) });
    const collection = {
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
    funding = {
      collection,
      findById: find,
      create: async value => { calls.push({ op: 'legacyCreate', value }); return value; },
      updateOne: (filter, update) => ({ exec: async () => { calls.push({ op: 'legacyUpdateOne', filter, update }); return { nModified: 1 }; } })
    };
    profile = { ...profile,
      collection: { findOne: async (filter, options) => { calls.push({ op: 'profileFindOne', filter, options }); return profile; } },
      findById: () => ({ lean: () => ({ exec: async () => profile }) })
    };
    mockery.enable({ useCleanCache: true, warnOnUnregistered: false, warnOnReplace: false });
    mockery.registerMock('mongoose', { models: { CareFunding: funding }, model: () => funding, Schema: function Schema() {}, connection: {} });
    mockery.registerMock('../models/CareWorkspace', { Profile: profile });
    mockery.registerMock('./careCrypto', { fromEnvironment: () => ({ open: sealed => sealed }) });
    mockery.registerMock('./careFamilyLifecycle', {
      createCareFamilyLifecycle: () => ({
        withOpenFamilyAccounts: async (familyId, accountIds, callback) => {
          calls.push({ op: 'withOpenFamilyAccounts', familyId, accountIds });
          if (lifecycleError) throw lifecycleError;
          const family = familyId === null ? null : { _id: familyId, owner: 'owner-a', sealed: { subscription: { startsAt: 1, expiresAt: Date.now() + 100000 } } };
          try { return await callback({ id: 'session-1' }, family); }
          catch (error) { calls.push({ op: 'transactionAbort', code: error.code }); throw error; }
        }
      })
    });
    store = require('../../api/helpers/careBudgetRuntime').store;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    else process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = previous;
    mockery.deregisterAll(); mockery.disable();
  });

  it('creates family funding inside the family/account transaction and returns false after duplicate abort', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    const value = { _id: 'funding-a', kind: 'family', familyId: 'family-a', owner: 'owner-a' };
    assert.equal(await store.create(value), true);
    funding.collection.insertOne = async (doc, options) => { calls.push({ op: 'insertOne', value: doc, options }); const e = Object.assign(new Error('duplicate'), { code: 11000 }); throw e; };
    assert.equal(await store.create(value), false);
    assert.equal(calls.at(-1).op, 'transactionAbort');
  });

  it('passes one session through reserve authorization and CAS', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    assert.equal(await store.cas('funding-a', 0, { rev: 1 }, { mode: 'reserve', actor: 'reader-a', profileId: 'profile-a' }), true);
    const tx = calls.find(c => c.op === 'withOpenFamilyAccounts');
    const write = calls.find(c => c.op === 'collectionUpdateOne');
    assert.deepEqual(tx.accountIds, ['owner-a', 'reader-a']);
    assert.deepEqual(write.options, { session: { id: 'session-1' } });
  });

  it('rejects a closing transaction without a funding write', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    lifecycleError = Object.assign(new Error('FAMILY_CLOSING'), { code: 'FAMILY_CLOSING' });
    await assert.rejects(store.cas('funding-a', 0, { rev: 1 }, { mode: 'reserve', actor: 'reader-a', profileId: 'profile-a' }), /FAMILY_CLOSING/);
    assert.equal(calls.some(c => c.op === 'collectionUpdateOne'), false);
  });

  it('keeps settle on the existing unfenced Funding CAS', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    assert.equal(await store.cas('funding-a', 0, { rev: 1 }, { mode: 'settle', actor: 'reader-a', requestId: 'r1' }), true);
    assert.deepEqual(calls.map(c => c.op), ['legacyUpdateOne']);
  });
  it('rejects malformed reserve context for institutional funding before profile queries or writes', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    current.kind = 'institution'; current.familyId = null;
    await assert.rejects(store.cas('funding-a', 0, { rev: 1 }, { mode: 'reserve', actor: 'reader-a', profileId: { $ne: null } }),
      error => error.code === 'FUNDING_ACCESS_DENIED');
    assert.deepEqual(calls, []);
  });
  it('rechecks profile read access inside the transaction before charging', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    profile.collection.findOne = async () => ({ ...profile, sealed: { grants: {}, deleted: false } });
    await assert.rejects(store.cas('funding-a', 0, { rev: 1 }, { mode: 'reserve', actor: 'reader-a', profileId: 'profile-a' }),
      error => error.code === 'FUNDING_ACCESS_DENIED');
    assert.equal(calls.some(call => call.op === 'collectionUpdateOne'), false);
  });

  it('requires the current family owner for delegate CAS', async () => {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    await assert.rejects(store.cas('funding-a', 0, { rev: 1 }, { mode: 'delegate', actor: 'reader-a' }), e => e.code === 'FUNDING_ADMIN_REQUIRED');
    assert.equal(calls.some(c => c.op === 'collectionUpdateOne'), false);
  });

  it('preserves institution CAS and all paths when the flag is disabled', async () => {
    delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    current = { _id: 'funding-i', rev: 2, kind: 'institution', owner: 'institution-a', familyId: null };
    assert.equal(await store.create(current), true);
    assert.equal(await store.cas('funding-i', 2, { rev: 3 }), true);
    assert.deepEqual(calls.map(c => c.op), ['legacyCreate', 'legacyUpdateOne']);
  });
});

'use strict';

const chai = require('chai');
const {
  FAMILY_CLOSED,
  FAMILY_CLOSING,
  FAMILY_CLOSE_CONFIRMATION_REQUIRED,
  FAMILY_TRANSFER_REQUIRED,
  TRANSACTION_OPTIONS,
  createCareFamilyLifecycle
} = require('../../api/helpers/careFamilyLifecycle');

const expect = chai.expect;

function collection({ one = null, families = [], profiles = [], updateResults = [], insertResults = [] } = {}) {
  const calls = { findOne: [], find: [], updateOne: [], insertOne: [] };
  return {
    calls,
    findOne(filter, options) {
      calls.findOne.push({ filter, options });
      return Promise.resolve(one);
    },
    find(filter, options) {
      calls.find.push({ filter, options });
      const values = filter && filter.owner !== undefined ? families : profiles;
      return { toArray: async () => values };
    },
    async updateOne(filter, update, options) {
      calls.updateOne.push({ filter, update, options });
      return updateResults.length ? updateResults.shift() : { matchedCount: 1 };
    },
    async insertOne(value, options) {
      calls.insertOne.push({ value, options });
      return insertResults.length ? insertResults.shift() : { acknowledged: true, insertedId: value._id };
    }
  };
}

function connectionFor() {
  const state = { options: null, ended: false, aborted: false, committed: false };
  const session = {
    async withTransaction(callback, options) {
      state.options = options;
      try {
        await callback(session);
        state.committed = true;
      } catch (error) {
        state.aborted = true;
        throw error;
      }
    },
    async endSession() { state.ended = true; }
  };
  return {
    state,
    connection: {
      async startSession() { return session; }
    }
  };
}

function factory({ family, profiles, account, updateResults, accountUpdateResults, now = 1700000000000, operationId = 'close-op' } = {}) {
  const session = connectionFor();
  const Family = collection({ one: family, families: Array.isArray(family) ? family : [], updateResults });
  const Profile = collection({ profiles });
  const AccountLifecycle = collection({ one: account, updateResults: accountUpdateResults });
  const lifecycle = createCareFamilyLifecycle({
    connection: session.connection,
    Family: { collection: Family },
    Profile: { collection: Profile },
    AccountLifecycle: { collection: AccountLifecycle },
    now: () => now,
    operationId: () => operationId
  });
  return { lifecycle, Family, Profile, AccountLifecycle, state: session.state };
}

async function expectCode(promise, code) {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error.code || error.message).to.equal(code);
  }
}

describe('care family lifecycle helper', function() {
  it('uses a transaction, primary snapshot options, and returns callback value', async function() {
    const f = factory({ family: { _id: 'family-a', owner: 'owner-1', lifecycleRev: 2 } });
    const result = await f.lifecycle.withOpenFamily('family-a', async (session, family) => ({
      session,
      family
    }));
    expect(result.family.lifecycleRev).to.equal(3);
    expect(f.state.options).to.deep.equal(TRANSACTION_OPTIONS);
    expect(f.state.committed).to.equal(true);
    expect(f.state.ended).to.equal(true);
    expect(f.Family.calls.updateOne).to.have.length(1);
    expect(f.Family.calls.updateOne[0].update).to.deep.equal({ $inc: { lifecycleRev: 1 } });
  });

  it('rejects missing, closed, and closing families before a lifecycle write', async function() {
    for (const family of [null, { _id: 'family-a', owner: 'owner-1', closure: { status: 'closed' } },
      { _id: 'family-a', owner: 'owner-1', closure: { status: 'closing' } }]) {
      const f = factory({ family });
      await expectCode(f.lifecycle.withOpenFamily('family-a', async () => true),
        family === null ? 'FAMILY_ACCESS_DENIED' : family.closure.status === 'closed' ? FAMILY_CLOSED : FAMILY_CLOSING);
      expect(f.Family.calls.updateOne).to.have.length(0);
      expect(f.state.aborted).to.equal(true);
    }
  });

  it('does not mutate when the confirmed family id set is stale', async function() {
    const f = factory({
      family: [{ _id: 'family-a', owner: 'owner-1' }, { _id: 'family-b', owner: 'owner-1' }]
    });
    await expectCode(f.lifecycle.beginClose('owner-1', ['family-a']), FAMILY_CLOSE_CONFIRMATION_REQUIRED);
    expect(f.Family.calls.updateOne).to.have.length(0);
    expect(f.state.aborted).to.equal(true);
  });

  it('does not mutate when any profile has another member', async function() {
    const f = factory({
      family: [{ _id: 'family-a', owner: 'owner-1' }],
      profiles: [{ _id: 'profile-a', familyId: 'family-a', members: ['owner-1', 'member-2'] }]
    });
    await expectCode(f.lifecycle.beginClose('owner-1', ['family-a']), FAMILY_TRANSFER_REQUIRED);
    expect(f.Family.calls.updateOne).to.have.length(0);
    expect(f.state.aborted).to.equal(true);
  });

  it('writes closing state and fences each confirmed family with lifecycleRev', async function() {
    const f = factory({
      family: [{ _id: 'family-a', owner: 'owner-1', lifecycleRev: 0 }, { _id: 'family-b', owner: 'owner-1', lifecycleRev: 4 }],
      profiles: [{ _id: 'profile-a', familyId: 'family-a', members: ['owner-1'] }]
    });
    const result = await f.lifecycle.beginClose('owner-1', ['family-b', 'family-a']);
    expect(result).to.deep.equal({ status: 'closing', owner: 'owner-1', familyIds: ['family-a', 'family-b'], operationId: 'close-op', at: 1700000000000 });
    expect(f.Family.calls.updateOne).to.have.length(2);
    expect(f.Family.calls.updateOne[0].update.$set.closure).to.deep.equal({ status: 'closing', operationId: 'close-op', owner: 'owner-1', at: 1700000000000 });
    expect(f.Family.calls.updateOne[0].update.$inc).to.deep.equal({ lifecycleRev: 1 });
    expect(f.AccountLifecycle.calls.updateOne[1].update.$set.closure.familyIds).to.deep.equal(['family-a', 'family-b']);
  });

  it('aborts when the open-family fence loses a race', async function() {
    const f = factory({ family: { _id: 'family-a', owner: 'owner-1' }, updateResults: [{ matchedCount: 0 }] });
    await expectCode(f.lifecycle.withOpenFamily('family-a', async () => true), 'FAMILY_CLOSE_CONFLICT');
    expect(f.state.aborted).to.equal(true);
    expect(f.state.committed).to.equal(false);
  });

  it('aborts callback errors and never falls back to an independent write', async function() {
    const f = factory({ family: { _id: 'family-a', owner: 'owner-1' } });
    await expectCode(f.lifecycle.withOpenFamily('family-a', async () => { throw new Error('callback failed'); }), 'callback failed');
    expect(f.state.aborted).to.equal(true);
    expect(f.state.committed).to.equal(false);
  });

  it('locks an existing account lifecycle document and returns the callback value', async function() {
    const f = factory({ account: { _id: 'owner-1', status: 'open', lifecycleRev: 7 } });
    const result = await f.lifecycle.withOpenAccount('owner-1', async (session, account) => ({ session, account }));
    expect(result.account.lifecycleRev).to.equal(8);
    expect(f.AccountLifecycle.calls.updateOne).to.have.length(1);
    expect(f.AccountLifecycle.calls.updateOne[0].update).to.deep.equal({ $inc: { lifecycleRev: 1 } });
    expect(f.state.committed).to.equal(true);
  });

  it('creates an initial account lifecycle document inside the same transaction', async function() {
    const f = factory();
    const result = await f.lifecycle.withOpenAccount('owner-1', async (session, account) => account);
    expect(result).to.include({ _id: 'owner-1', status: 'open', lifecycleRev: 1 });
    expect(f.AccountLifecycle.calls.insertOne).to.deep.equal([
      { value: { _id: 'owner-1', status: 'open', lifecycleRev: 0 }, options: { session: f.AccountLifecycle.calls.insertOne[0].options.session } }
    ]);
  });

  it('rejects account lifecycle states before callback or family writes', async function() {
    for (const account of [
      { _id: 'owner-1', status: 'closing' },
      { _id: 'owner-1', status: 'closed' },
      { _id: 'owner-1', status: 'unexpected' }
    ]) {
      const f = factory({ account });
      await expectCode(f.lifecycle.withOpenAccount('owner-1', async () => true),
        account.status === 'closing' ? 'ACCOUNT_CLOSING' : account.status === 'closed' ? 'ACCOUNT_CLOSED' : 'ACCOUNT_CLOSE_CONFLICT');
      expect(f.AccountLifecycle.calls.updateOne).to.have.length(0);
      expect(f.AccountLifecycle.calls.insertOne).to.have.length(0);
      expect(f.state.aborted).to.equal(true);
    }
  });

  it('routes createFamily through the account fence and the same session', async function() {
    const f = factory({ account: { _id: 'owner-1', status: 'open', lifecycleRev: 0 } });
    await f.lifecycle.createFamily({ _id: 'family-a', owner: 'owner-1', sealed: {} });
    expect(f.AccountLifecycle.calls.updateOne).to.have.length(1);
    expect(f.Family.calls.insertOne).to.deep.equal([
      { value: { _id: 'family-a', owner: 'owner-1', sealed: {} }, options: { session: f.Family.calls.insertOne[0].options.session } }
    ]);
  });

  it('aborts the transaction containing the initial gate when confirmation is stale', async function() {
    const f = factory({ family: [{ _id: 'family-a', owner: 'owner-1' }] });
    await expectCode(f.lifecycle.beginClose('owner-1', ['family-stale']), FAMILY_CLOSE_CONFIRMATION_REQUIRED);
    expect(f.AccountLifecycle.calls.updateOne).to.have.length(1);
    expect(f.AccountLifecycle.calls.insertOne).to.have.length(1);
    expect(f.state.aborted).to.equal(true);
    expect(f.state.committed).to.equal(false);
    expect(f.Family.calls.updateOne).to.have.length(0);
  });

  it('rejects createFamily after account close without a fallback insert', async function() {
    const f = factory({ account: { _id: 'owner-1', status: 'closed' } });
    await expectCode(f.lifecycle.createFamily({ _id: 'family-a', owner: 'owner-1' }), 'ACCOUNT_CLOSED');
    expect(f.Family.calls.insertOne).to.have.length(0);
  });
});

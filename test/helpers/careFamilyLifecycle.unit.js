'use strict';

const chai = require('chai');
const {
  FAMILY_ACCESS_DENIED,
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

function factory({ family, profile, profiles, account, updateResults, profileUpdateResults, accountUpdateResults, prepareClose = null, now = 1700000000000, operationId = 'close-op' } = {}) {
  const session = connectionFor();
  const Family = collection({ one: family, families: Array.isArray(family) ? family : [], updateResults });
  const Profile = collection({ one: profile, profiles, updateResults: profileUpdateResults });
  const Communicator = collection();
  const AccountLifecycle = collection({ one: account, updateResults: accountUpdateResults });
  const lifecycle = createCareFamilyLifecycle({
    connection: session.connection,
    Family: { collection: Family },
    Profile: { collection: Profile },
    Communicator: { collection: Communicator },
    AccountLifecycle: { collection: AccountLifecycle },
    prepareClose,
    now: () => now,
    operationId: () => operationId
  });
  return { lifecycle, Family, Profile, Communicator, AccountLifecycle, state: session.state };
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
  it('rejects closing actors or invited accounts but permits removal of closing members', async function() {
    for (const mode of ['actor', 'invite', 'remove']) {
      const f = factory({ family: { _id: 'family-a', owner: 'owner-a' },
        profile: { _id: 'profile-a', familyId: 'family-a', rev: 0,
          members: mode === 'invite' ? ['owner-a'] : ['owner-a', 'closing-user'] } });
      f.AccountLifecycle.findOne = async filter => ({ _id: filter._id,
        status: filter._id === 'closing-user' ? 'closing' : 'open' });
      const result = f.lifecycle.casProfile('profile-a', 0, { sealed: {}, rev: 1,
        members: mode === 'remove' ? ['owner-a'] : ['owner-a', 'closing-user'] },
      { actor: mode === 'actor' ? 'closing-user' : 'owner-a' });
      if (mode === 'remove') expect(await result).to.equal(true);
      else {
        await expectCode(result, 'ACCOUNT_CLOSING');
        expect(f.Profile.calls.updateOne).to.have.length(0);
        expect(f.Family.calls.updateOne).to.have.length(0);
      }
    }
  });

  it('fences both transfer owners in sorted order and writes in the same session', async function() {
    const f = factory({ family: { _id: 'family-a', owner: 'owner-z', rev: 2 } });
    expect(await f.lifecycle.casFamily('family-a', 2, { owner: 'owner-a', rev: 3 })).to.equal(true);
    expect(f.AccountLifecycle.calls.updateOne.map(call => call.filter._id)).to.deep.equal(['owner-a', 'owner-z']);
    const write = f.Family.calls.updateOne[0];
    expect(write.options.session).to.equal(f.AccountLifecycle.calls.updateOne[0].options.session);
    expect(write.filter.owner).to.equal('owner-z');
    expect(write.update.$set).to.deep.equal({ owner: 'owner-a', rev: 3 });
  });

  it('returns false for stale revisions without acquiring account gates', async function() {
    const f = factory({ family: { _id: 'family-a', owner: 'owner-a', rev: 3 } });
    expect(await f.lifecycle.casFamily('family-a', 2, { rev: 3 })).to.equal(false);
    expect(f.AccountLifecycle.calls.updateOne).to.have.length(0);
    expect(f.Family.calls.updateOne).to.have.length(0);
  });

  it('rejects transfer when either account is closing', async function() {
    for (const blocked of ['owner-a', 'owner-z']) {
      const f = factory({ family: { _id: 'family-a', owner: 'owner-z', rev: 0 } });
      f.AccountLifecycle.findOne = async filter => ({ _id: filter._id, status: filter._id === blocked ? 'closing' : 'open' });
      await expectCode(f.lifecycle.casFamily('family-a', 0, { owner: 'owner-a', rev: 1 }), 'ACCOUNT_CLOSING');
      expect(f.Family.calls.updateOne).to.have.length(0);
      expect(f.state.aborted).to.equal(true);
    }
  });

  it('does not permit a family update to replace closure metadata', async function() {
    const f = factory();
    await expectCode(f.lifecycle.casFamily('family-a', 0, { rev: 1, closure: { status: 'open' } }), 'INVALID_FAMILY_UPDATE');
    expect(f.Family.calls.updateOne).to.have.length(0);
  });

  it('CAS-updates a profile after fencing its account and family in one session', async function() {
    const f = factory({
      profile: { _id: 'profile-a', familyId: 'family-a', rev: 4 },
      family: { _id: 'family-a', owner: 'owner-1', closure: { status: 'open' } }
    });
    expect(await f.lifecycle.casProfile('profile-a', 4, { sealed: { v: 2 }, rev: 5, members: ['owner-1'] })).to.equal(true);
    expect(f.AccountLifecycle.calls.updateOne.map(call => call.filter._id)).to.deep.equal(['owner-1']);
    expect(f.Family.calls.updateOne).to.have.length(1);
    expect(f.Profile.calls.updateOne).to.have.length(1);
    expect(f.Profile.calls.updateOne[0].options.session).to.equal(f.Family.calls.updateOne[0].options.session);
    expect(f.Profile.calls.updateOne[0].filter.familyId).to.equal('family-a');
    expect(f.Profile.calls.updateOne[0].update.$set).to.deep.equal({ sealed: { v: 2 }, rev: 5, members: ['owner-1'] });
  });

  it('returns false for a stale profile revision without family or account writes', async function() {
    const f = factory({
      profile: { _id: 'profile-a', familyId: 'family-a', rev: 5 },
      family: { _id: 'family-a', owner: 'owner-1' }
    });
    expect(await f.lifecycle.casProfile('profile-a', 4, { sealed: {}, rev: 5, members: [] })).to.equal(false);
    expect(f.AccountLifecycle.calls.updateOne).to.have.length(0);
    expect(f.Family.calls.updateOne).to.have.length(0);
    expect(f.Profile.calls.updateOne).to.have.length(0);
  });

  it('rejects a missing profile before any lifecycle or family write', async function() {
    const f = factory({ family: { _id: 'family-a', owner: 'owner-1' } });
    await expectCode(f.lifecycle.casProfile('profile-a', 0, { sealed: {}, rev: 1, members: [] }), 'PROFILE_ACCESS_DENIED');
    expect(f.AccountLifecycle.calls.updateOne).to.have.length(0);
    expect(f.Family.calls.updateOne).to.have.length(0);
    expect(f.Profile.calls.updateOne).to.have.length(0);
    expect(f.state.aborted).to.equal(true);
  });

  it('returns false for an old owner after authorization changed without writing', async function() {
    const f = factory({
      profile: { _id: 'profile-a', familyId: 'family-a', rev: 1 },
      family: { _id: 'family-a', owner: 'new-owner' }
    });
    expect(await f.lifecycle.casProfile('profile-a', 1, { sealed: {}, rev: 2, members: ['new-owner'] }, {
      expectedOwner: 'old-owner'
    })).to.equal(false);
    expect(f.AccountLifecycle.calls.updateOne).to.have.length(0);
    expect(f.Family.calls.updateOne).to.have.length(0);
    expect(f.Profile.calls.updateOne).to.have.length(0);
  });

  it('rejects profile writes while the family is closing', async function() {
    const f = factory({
      profile: { _id: 'profile-a', familyId: 'family-a', rev: 1 },
      family: { _id: 'family-a', owner: 'owner-1', closure: { status: 'closing' } }
    });
    await expectCode(f.lifecycle.casProfile('profile-a', 1, { sealed: {}, rev: 2, members: [] }), FAMILY_CLOSING);
    expect(f.AccountLifecycle.calls.updateOne).to.have.length(0);
    expect(f.Family.calls.updateOne).to.have.length(0);
    expect(f.Profile.calls.updateOne).to.have.length(0);
  });

  it('fails closed when the profile CAS loses a race', async function() {
    const f = factory({
      profile: { _id: 'profile-a', familyId: 'family-a', rev: 1 },
      family: { _id: 'family-a', owner: 'owner-1' },
      profileUpdateResults: [{ matchedCount: 0 }]
    });
    await expectCode(f.lifecycle.casProfile('profile-a', 1, { sealed: {}, rev: 2, members: [] }), 'FAMILY_CLOSE_CONFLICT');
    expect(f.state.aborted).to.equal(true);
    expect(f.Family.calls.updateOne).to.have.length(1);
    expect(f.Profile.calls.updateOne).to.have.length(1);
  });

  it('creates a communicator and profile after the account and family fences in one session', async function() {
    const f = factory({ family: { _id: 'family-a', owner: 'owner-1' } });
    const value = { _id: 'profile-a', familyId: 'family-a', owner: 'owner-1', members: ['owner-1'], rev: 0, sealed: { v: 1 } };
    const communicator = { careProfileId: 'profile-a', careFamilyId: 'family-a', name: 'shared' };
    expect(await f.lifecycle.createProfile(value, communicator)).to.equal(value);
    const accountSession = f.AccountLifecycle.calls.updateOne[0].options.session;
    expect(f.Family.calls.updateOne[0].options.session).to.equal(accountSession);
    expect(f.Communicator.calls.insertOne[0].options.session).to.equal(accountSession);
    expect(f.Profile.calls.insertOne[0].options.session).to.equal(accountSession);
  });

  it('rejects profile creation for a closing or differently owned family before inserts', async function() {
    const cases = [
      { family: { _id: 'family-a', owner: 'owner-1', closure: { status: 'closing' } }, code: FAMILY_CLOSING },
      { family: { _id: 'family-a', owner: 'other-owner' }, code: FAMILY_ACCESS_DENIED }
    ];
    for (const item of cases) {
      const f = factory({ family: item.family });
      const value = { _id: 'profile-a', familyId: 'family-a', owner: 'owner-1', members: ['owner-1'], rev: 0 };
      await expectCode(f.lifecycle.createProfile(value, { careProfileId: 'profile-a', careFamilyId: 'family-a' }), item.code);
      expect(f.Communicator.calls.insertOne).to.have.length(0);
      expect(f.Profile.calls.insertOne).to.have.length(0);
    }
  });

  it('aborts when profile insertion fails after communicator insertion', async function() {
    const f = factory({ family: { _id: 'family-a', owner: 'owner-1' } });
    f.Profile.insertOne = async () => { throw new Error('profile insert failed'); };
    const value = { _id: 'profile-a', familyId: 'family-a', owner: 'owner-1', members: ['owner-1'], rev: 0 };
    await expectCode(f.lifecycle.createProfile(value, { careProfileId: 'profile-a', careFamilyId: 'family-a' }), 'profile insert failed');
    expect(f.Communicator.calls.insertOne).to.have.length(1);
    expect(f.state.aborted).to.equal(true);
    expect(f.state.committed).to.equal(false);
  });

  it('locks family and requested accounts in sorted order before callback', async function() {
    const f = factory({ family: { _id: 'family-a', owner: 'owner-z' } });
    const result = await f.lifecycle.withOpenFamilyAccounts('family-a', ['owner-b', 'owner-z', 'owner-a'], async (session, family) => ({ session, family }));
    expect(result.family._id).to.equal('family-a');
    expect(f.AccountLifecycle.calls.updateOne.map(call => call.filter._id)).to.deep.equal(['owner-a', 'owner-b', 'owner-z']);
    expect(f.Family.calls.updateOne).to.have.length(1);
    expect(f.Family.calls.updateOne[0].options.session).to.equal(f.AccountLifecycle.calls.updateOne[0].options.session);
  });

  it('rejects a closing family before account locks or family writes', async function() {
    const f = factory({ family: { _id: 'family-a', owner: 'owner-1', closure: { status: 'closing' } } });
    await expectCode(f.lifecycle.withOpenFamilyAccounts('family-a', ['owner-1'], async () => true), FAMILY_CLOSING);
    expect(f.AccountLifecycle.calls.updateOne).to.have.length(0);
    expect(f.Family.calls.updateOne).to.have.length(0);
  });

  it('supports institution work with no family while still requiring an account lock', async function() {
    const f = factory();
    const result = await f.lifecycle.withOpenFamilyAccounts(null, ['institution-1', 'institution-1'], async (session, family) => ({ session, family }));
    expect(result.family).to.equal(null);
    expect(f.AccountLifecycle.calls.updateOne.map(call => call.filter._id)).to.deep.equal(['institution-1']);
    expect(f.Family.calls.updateOne).to.have.length(0);
  });

  it('aborts the transaction when the callback fails', async function() {
    const f = factory({ family: { _id: 'family-a', owner: 'owner-1' } });
    await expectCode(f.lifecycle.withOpenFamilyAccounts('family-a', ['owner-1'], async () => { throw new Error('quota callback failed'); }), 'quota callback failed');
    expect(f.state.aborted).to.equal(true);
    expect(f.state.committed).to.equal(false);
  });

  it('returns an existing closing record idempotently without generating or writing', async function() {
    let generated = 0;
    const f = factory({
      account: {
        _id: 'owner-1',
        status: 'closing',
        closure: { owner: 'owner-1', operationId: 'close-existing', familyIds: ['family-a'], at: 1700000000000 }
      },
      operationId: () => { generated += 1; return 'close-new'; },
      prepareClose: async () => { throw new Error('must not prepare'); }
    });
    const result = await f.lifecycle.beginClose('owner-1', ['family-a']);
    expect(result).to.deep.equal({ status: 'closing', owner: 'owner-1', familyIds: ['family-a'], operationId: 'close-existing', at: 1700000000000 });
    expect(generated).to.equal(0);
    expect(f.AccountLifecycle.calls.updateOne).to.have.length(0);
    expect(f.Family.calls.updateOne).to.have.length(0);
  });

  it('rejects a different confirmation against an existing closing record without writing', async function() {
    const f = factory({
      account: {
        _id: 'owner-1',
        status: 'closing',
        closure: { owner: 'owner-1', operationId: 'close-existing', familyIds: ['family-a'], at: 1700000000000 }
      }
    });
    try {
      await f.lifecycle.beginClose('owner-1', ['family-b']);
      throw new Error('expected FAMILY_CLOSE_CONFIRMATION_REQUIRED');
    } catch (error) {
      expect(error.code).to.equal(FAMILY_CLOSE_CONFIRMATION_REQUIRED);
      expect(error.details.familyIds).to.deep.equal(['family-a']);
    }
    expect(f.AccountLifecycle.calls.updateOne).to.have.length(0);
    expect(f.Family.calls.updateOne).to.have.length(0);
  });

  it('runs prepareClose after closing writes in the same session', async function() {
    let prepared;
    const f = factory({
      family: [{ _id: 'family-a', owner: 'owner-1' }],
      profiles: [{ _id: 'profile-a', familyId: 'family-a', members: ['owner-1'] }],
      prepareClose: async (session, result) => { prepared = { session, result }; }
    });
    const result = await f.lifecycle.beginClose('owner-1', ['family-a']);
    expect(prepared.result).to.deep.equal(result);
    expect(prepared.session).to.equal(f.AccountLifecycle.calls.updateOne[1].options.session);
    expect(prepared.session).to.equal(f.Family.calls.updateOne[0].options.session);
  });
  it('rejects a damaged persisted closing timestamp instead of resuming it', async function() {
    const f = factory({ account: { _id: 'owner-1', status: 'closing', closure: {
      owner: 'owner-1', familyIds: ['family-a'], operationId: 'existing-op'
    } } });
    await expectCode(f.lifecycle.beginClose('owner-1', ['family-a']), 'ACCOUNT_CLOSE_CONFLICT');
    expect(f.AccountLifecycle.calls.updateOne).to.have.length(0);
  });

  it('aborts closing writes when prepareClose fails', async function() {
    const f = factory({
      family: [{ _id: 'family-a', owner: 'owner-1' }],
      profiles: [{ _id: 'profile-a', familyId: 'family-a', members: ['owner-1'] }],
      prepareClose: async () => { throw new Error('prepare failed'); }
    });
    await expectCode(f.lifecycle.beginClose('owner-1', ['family-a']), 'prepare failed');
    expect(f.state.aborted).to.equal(true);
    expect(f.state.committed).to.equal(false);
  });

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

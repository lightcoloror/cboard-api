'use strict';

const assert = require('assert').strict;
const crypto = require('crypto');
const { createCareCrypto } = require('../../api/helpers/careCrypto');
const { createCareBudget } = require('../../api/helpers/careBudget');
const { createCareSubscription } = require('../../api/helpers/careSubscription');
const { createCareTrialClaim } = require('../../api/helpers/careTrialClaim');

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const policy = { version: 'public-v1', trialUnits: 12, weeklyLimit: 4, trialDurationMs: 3 * 86400000, subscriptionDurationMs: 7 * 86400000 };

function fixture() {
  const accounts = {}, families = {}, fundings = {};
  const encryption = createCareCrypto({ test: crypto.randomBytes(32).toString('hex') }, 'test');
  const accountStore = {
    get: async id => clone(accounts[id]),
    create: async doc => { if (accounts[doc._id]) return false; accounts[doc._id] = clone(doc); return true; },
    cas: async (id, rev, value) => { if (!accounts[id] || accounts[id].rev !== rev) return false; accounts[id] = clone(value); return true; }
  };
  const familyStore = {
    get: async id => clone(families[id]),
    cas: async (id, rev, value) => { if (!families[id] || families[id].rev !== rev) return false; families[id] = { ...families[id], ...clone(value) }; return true; }
  };
  const fundingStore = {
    get: async id => clone(fundings[id]),
    create: async doc => { if (fundings[doc._id]) return false; fundings[doc._id] = clone(doc); return true; },
    cas: async (id, rev, value) => { if (!fundings[id] || fundings[id].rev !== rev) return false; fundings[id] = { ...fundings[id], ...clone(value) }; return true; }
  };
  const budget = createCareBudget({ store: fundingStore, encryption, now: () => 1000 });
  const subscription = createCareSubscription({ store: { getFamily: familyStore.get, casFamily: familyStore.cas }, encryption });
  const claim = createCareTrialClaim({ accountStore, familyStore, fundingStore, encryption, subscription, budget, accountEligibility: { isVerified: async () => true }, policy, now: () => 1000 });
  const addFamily = (id, owner) => { families[id] = { _id: id, owner, rev: 0, sealed: encryption.seal({ name: id, subscription: null }, `family:${id}`) }; };
  return { accounts, families, fundings, encryption, budget, claim, addFamily };
}

describe('care trial claim', function() {
  it('only grants server-configured trial once per account and once per family', async function() {
    const f = fixture(); f.addFamily('family-a', 'user-a'); f.addFamily('family-b', 'user-a');
    const [first, replay] = await Promise.all([
      f.claim.claim('user-a', 'family-a'),
      f.claim.claim('user-a', 'family-a')
    ]);
    assert.equal(first.status, 'complete');
    assert.equal(replay.fundingId, first.fundingId);
    assert.equal((await f.claim.claim('user-a', 'family-a')).fundingId, first.fundingId);
    await assert.rejects(f.claim.claim('user-a', 'family-b'), error => error.code === 'TRIAL_ACCOUNT_ALREADY_CLAIMED');
    await assert.rejects(f.claim.claim('user-b', 'family-a'), error => error.code === 'FAMILY_OWNER_REQUIRED');
    assert.equal((await f.budget.snapshot(first.fundingId, 'user-a', 'profile-a')).packs[0].amount, 12);
    assert.equal(f.encryption.open(f.fundings[first.fundingId].sealed, `funding:${first.fundingId}`).trialPending, false);
  });

  it('allows at most one concurrent family claim for the same account', async function() {
    const f = fixture(); f.addFamily('family-a', 'user-a'); f.addFamily('family-b', 'user-a');
    const results = await Promise.allSettled([
      f.claim.claim('user-a', 'family-a'),
      f.claim.claim('user-a', 'family-b')
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'TRIAL_ACCOUNT_ALREADY_CLAIMED');
    assert.equal(Object.keys(f.fundings).length, 1);
  });

  it('rejects a different owner racing for an already reserved family without creating funding', async function() {
    const f = fixture(); f.addFamily('family-a', 'user-a');
    const first = await f.claim.claim('user-a', 'family-a');
    f.families['family-a'].owner = 'user-b';
    await assert.rejects(f.claim.claim('user-b', 'family-a'), error => error.code === 'TRIAL_FAMILY_ALREADY_CLAIMED');
    assert.equal(Object.keys(f.fundings).length, 1);
    assert(Object.values(f.fundings).some(value => value._id === first.fundingId));
  });

  it('recovers a transient funding-pack failure without duplicating subscription or funding', async function() {
    const f = fixture(); f.addFamily('family-a', 'user-a');
    const original = f.budget.addPack; let failOnce = true;
    f.budget.addPack = async (...args) => { if (failOnce) { failOnce = false; const error = new Error('interrupted'); error.code = 'INTERRUPTED'; throw error; } return original(...args); };
    const claim = createCareTrialClaim({
      accountStore: { get: async id => clone(f.accounts[id]), create: async d => { if (f.accounts[d._id]) return false; f.accounts[d._id] = clone(d); return true; }, cas: async (id, rev, value) => { if (f.accounts[id].rev !== rev) return false; f.accounts[id] = clone(value); return true; } },
      familyStore: { get: async id => clone(f.families[id]), cas: async (id, rev, value) => { if (f.families[id].rev !== rev) return false; f.families[id] = { ...f.families[id], ...clone(value) }; return true; } },
      fundingStore: { get: async id => clone(f.fundings[id]), create: async d => { if (f.fundings[d._id]) return false; f.fundings[d._id] = clone(d); return true; }, cas: async (id, rev, value) => { if (f.fundings[id].rev !== rev) return false; f.fundings[id] = { ...f.fundings[id], ...clone(value) }; return true; } },
      encryption: f.encryption,
      subscription: createCareSubscription({ store: { getFamily: async id => clone(f.families[id]), casFamily: async (id, rev, value) => { if (f.families[id].rev !== rev) return false; f.families[id] = { ...f.families[id], ...clone(value) }; return true; } }, encryption: f.encryption }),
      budget: f.budget,
      accountEligibility: { isVerified: async () => true },
      policy,
      now: () => 1000
    });
    await assert.rejects(claim.claim('user-a', 'family-a'), error => error.code === 'INTERRUPTED');
    const result = await claim.claim('user-a', 'family-a');
    assert.equal(result.status, 'complete');
    assert.equal(Object.keys(f.fundings).length, 1);
    const funding = f.encryption.open(f.fundings[result.fundingId].sealed, `funding:${result.fundingId}`);
    assert.equal(funding.packs.length, 1);
    const family = f.encryption.open(f.families['family-a'].sealed, 'family:family-a');
    assert.equal(Object.keys(family.subscriptionReceipts).length, 1);
  });

  it('does not grant when the server policy is absent or the caller is not the family owner', async function() {
    const f = fixture(); f.addFamily('family-a', 'user-a');
    const missing = createCareTrialClaim({ accountStore: {}, familyStore: {}, fundingStore: {}, encryption: f.encryption, subscription: {}, budget: {}, policy: null });
    await assert.rejects(missing.claim('user-a', 'family-a'), error => error.code === 'TRIAL_NOT_CONFIGURED');
    const unverified = createCareTrialClaim({ accountStore: {}, familyStore: {}, fundingStore: {}, encryption: f.encryption, subscription: {}, budget: {}, policy });
    await assert.rejects(unverified.claim('user-a', 'family-a'), error => error.code === 'ACCOUNT_VERIFICATION_REQUIRED');
    await assert.rejects(f.claim.claim('user-b', 'family-a'), error => error.code === 'FAMILY_OWNER_REQUIRED');
    assert.equal(Object.keys(f.fundings).length, 0);
  });

  it('rejects an invalid family, a non-owner, and an existing subscription before writing an account claim', async function() {
    const f = fixture();
    await assert.rejects(f.claim.claim('user-a', 'missing'), error => error.code === 'FAMILY_NOT_FOUND');
    assert.equal(Object.keys(f.accounts).length, 0);
    f.addFamily('family-a', 'user-b');
    await assert.rejects(f.claim.claim('user-a', 'family-a'), error => error.code === 'FAMILY_OWNER_REQUIRED');
    assert.equal(Object.keys(f.accounts).length, 0);
    f.families['family-a'].owner = 'user-a';
    const state = f.encryption.open(f.families['family-a'].sealed, 'family:family-a');
    state.subscription = { startsAt: 1, expiresAt: 9999 };
    f.families['family-a'].sealed = f.encryption.seal(state, 'family:family-a');
    await assert.rejects(f.claim.claim('user-a', 'family-a'), error => error.code === 'TRIAL_SUBSCRIPTION_EXISTS');
    assert.equal(Object.keys(f.accounts).length, 0);
  });

  it('replays a pending claim using its frozen policy after the configured policy changes', async function() {
    const f = fixture(); f.addFamily('family-a', 'user-a');
    const original = f.budget.addPack; let failOnce = true;
    f.budget.addPack = async (...args) => { if (failOnce) { failOnce = false; const error = new Error('interrupted'); error.code = 'INTERRUPTED'; throw error; } return original(...args); };
    await assert.rejects(f.claim.claim('user-a', 'family-a'), error => error.code === 'INTERRUPTED');
    const changed = createCareTrialClaim({
      accountStore: { get: async id => clone(f.accounts[id]), create: async d => { if (f.accounts[d._id]) return false; f.accounts[d._id] = clone(d); return true; }, cas: async (id, rev, value) => { if (f.accounts[id].rev !== rev) return false; f.accounts[id] = clone(value); return true; } },
      familyStore: { get: async id => clone(f.families[id]), cas: async (id, rev, value) => { if (f.families[id].rev !== rev) return false; f.families[id] = { ...f.families[id], ...clone(value) }; return true; } },
      fundingStore: { get: async id => clone(f.fundings[id]), create: async d => { if (f.fundings[d._id]) return false; f.fundings[d._id] = clone(d); return true; }, cas: async (id, rev, value) => { if (f.fundings[id].rev !== rev) return false; f.fundings[id] = { ...f.fundings[id], ...clone(value) }; return true; } },
      encryption: f.encryption,
      subscription: createCareSubscription({ store: { getFamily: async id => clone(f.families[id]), casFamily: async (id, rev, value) => { if (f.families[id].rev !== rev) return false; f.families[id] = { ...f.families[id], ...clone(value) }; return true; } }, encryption: f.encryption }),
      budget: f.budget,
      accountEligibility: { isVerified: async () => true },
      policy: { ...policy, version: 'public-v2', trialUnits: 99, weeklyLimit: 77 },
      now: () => 5000
    });
    const result = await changed.claim('user-a', 'family-a');
    const funding = f.encryption.open(f.fundings[result.fundingId].sealed, `funding:${result.fundingId}`);
    assert.equal(funding.weeklyLimit, policy.weeklyLimit);
    assert.equal(funding.packs[0].amount, policy.trialUnits);
  });

  it('does not overwrite an unrelated subscription activated while a claim is pending', async function() {
    const f = fixture(); f.addFamily('family-a', 'user-a');
    const original = f.budget.addPack; let failOnce = true;
    f.budget.addPack = async (...args) => { if (failOnce) { failOnce = false; const error = new Error('interrupted'); error.code = 'INTERRUPTED'; throw error; } return original(...args); };
    await assert.rejects(f.claim.claim('user-a', 'family-a'), error => error.code === 'INTERRUPTED');
    const subscriptions = createCareSubscription({ store: { getFamily: async id => clone(f.families[id]), casFamily: async (id, rev, value) => { if (f.families[id].rev !== rev) return false; f.families[id] = { ...f.families[id], ...clone(value) }; return true; } }, encryption: f.encryption });
    await subscriptions.activate({ familyId: 'family-a', payerId: 'user-a', receiptId: 'other-subscription', startsAt: 1000, expiresAt: 9000 });
    await assert.rejects(f.claim.claim('user-a', 'family-a'), error => error.code === 'TRIAL_SUBSCRIPTION_EXISTS');
    const state = f.encryption.open(f.families['family-a'].sealed, 'family:family-a');
    assert.equal(state.subscription.expiresAt, 9000);
    assert.equal(Object.keys(state.subscriptionReceipts).length, 1);
  });

  it('does not activate trial subscription when ownership changes after funding is prepared', async function() {
    const f = fixture(); f.addFamily('family-a', 'user-a');
    const original = f.budget.addPack;
    f.budget.addPack = async (...args) => {
      const value = await original(...args);
      f.families['family-a'].owner = 'user-b';
      return value;
    };
    await assert.rejects(f.claim.claim('user-a', 'family-a'), error => error.code === 'SUBSCRIPTION_OWNER_CHANGED');
    const state = f.encryption.open(f.families['family-a'].sealed, 'family:family-a');
    assert.equal(state.subscription, null);
    assert.equal(Object.keys(f.fundings).length, 1);
    const pendingFunding = Object.values(f.fundings)[0];
    assert.equal(f.encryption.open(pendingFunding.sealed, `funding:${pendingFunding._id}`).trialPending, true);
    assert.equal((await f.budget.snapshot(pendingFunding._id, 'user-a', 'profile-a')).available, 0);
    await assert.rejects(f.budget.reserve(pendingFunding._id, { actor: 'user-a', profileId: 'profile-a', requestId: 'pending-use', units: 1, fingerprint: 'a'.repeat(64) }), error => error.code === 'TRIAL_PENDING_ACTIVATION');
    await assert.rejects(f.claim.claim('user-b', 'family-a'), error => error.code === 'TRIAL_FAMILY_ALREADY_CLAIMED');
  });

  it('does not overwrite a subscription that races in after funding preparation', async function() {
    const f = fixture(); f.addFamily('family-a', 'user-a');
    const subscriptions = createCareSubscription({ store: { getFamily: async id => clone(f.families[id]), casFamily: async (id, rev, value) => { if (f.families[id].rev !== rev) return false; f.families[id] = { ...f.families[id], ...clone(value) }; return true; } }, encryption: f.encryption });
    const original = f.budget.addPack;
    f.budget.addPack = async (...args) => {
      const result = await original(...args);
      await subscriptions.activate({ familyId: 'family-a', payerId: 'user-a', receiptId: 'race-subscription', startsAt: 1000, expiresAt: 9000 });
      return result;
    };
    await assert.rejects(f.claim.claim('user-a', 'family-a'), error => error.code === 'SUBSCRIPTION_EXISTS');
    const state = f.encryption.open(f.families['family-a'].sealed, 'family:family-a');
    assert.equal(state.subscription.expiresAt, 9000);
    assert.equal(Object.keys(state.subscriptionReceipts).length, 1);
    assert.equal(f.encryption.open(Object.values(f.fundings)[0].sealed, `funding:${Object.values(f.fundings)[0]._id}`).trialPending, true);
  });
});

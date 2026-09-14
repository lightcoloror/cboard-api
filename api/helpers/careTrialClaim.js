'use strict';

const crypto = require('crypto');
const { fail } = require('./carePolicy');

const valid = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const clone = value => JSON.parse(JSON.stringify(value));
const deterministicId = (prefix, ...values) => `${prefix}-${crypto.createHash('sha256').update(values.join(':')).digest('hex').slice(0, 40)}`;

function validatePolicy(policy) {
  if (!policy || !valid(policy.version) || !Number.isSafeInteger(policy.trialUnits) || policy.trialUnits <= 0 ||
      !Number.isSafeInteger(policy.weeklyLimit) || policy.weeklyLimit < 0 ||
      !Number.isSafeInteger(policy.trialDurationMs) || policy.trialDurationMs <= 0 ||
      !Number.isSafeInteger(policy.subscriptionDurationMs) || policy.subscriptionDurationMs <= 0) return null;
  return { ...policy };
}

function createCareTrialClaim({ accountStore, familyStore, fundingStore, encryption, subscription, budget, accountEligibility = { isVerified: async () => false }, policy, now = Date.now }) {
  const configuredPolicy = validatePolicy(policy);

  async function mutateAccount(accountId, fn) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const doc = await accountStore.get(accountId);
      const state = doc ? encryption.open(doc.sealed, `account:${accountId}`) : { selectedProfileId: null };
      const result = fn(state);
      if (result.noWrite) return result.value;
      const next = { _id: accountId, rev: doc ? doc.rev + 1 : 0, sealed: encryption.seal(state, `account:${accountId}`) };
      if (doc ? await accountStore.cas(accountId, doc.rev, next) : await accountStore.create(next)) return result.value;
    }
    fail(409, 'RETRY_CONCURRENT_CHANGE');
  }

  async function reserveAccount(accountId, familyId) {
    const claimId = deterministicId('trial', accountId, familyId);
    return mutateAccount(accountId, state => {
      const current = state.trialClaim;
      if (current) {
        if (current.claimId !== claimId || current.familyId !== familyId) fail(409, 'TRIAL_ACCOUNT_ALREADY_CLAIMED');
        return { noWrite: true, value: clone(current) };
      }
      const startedAt = now();
      const value = {
        claimId,
        accountId,
        familyId,
        policy: configuredPolicy,
        fundingId: deterministicId('trial-funding', claimId),
        subscriptionReceiptId: deterministicId('trial-subscription', claimId),
        packId: deterministicId('trial-pack', claimId),
        startedAt,
        subscriptionExpiresAt: startedAt + configuredPolicy.subscriptionDurationMs,
        trialExpiresAt: startedAt + configuredPolicy.trialDurationMs,
        status: 'pending'
      };
      state.trialClaim = value;
      return { value: clone(value) };
    });
  }

  async function inspectEligibleFamily(accountId, familyId, claimId, subscriptionReceiptId) {
    const family = await familyStore.get(familyId);
    if (!family) fail(404, 'FAMILY_NOT_FOUND');
    if (family.owner !== accountId) fail(403, 'FAMILY_OWNER_REQUIRED');
    const state = encryption.open(family.sealed, `family:${familyId}`);
    const ownTrial = state.trialClaim && state.trialClaim.claimId === claimId;
    if (state.trialClaim && !ownTrial) fail(409, 'TRIAL_FAMILY_ALREADY_CLAIMED');
    // A family reservation alone does not authorize overwriting an unrelated
    // subscription that appeared while a claim was pending.  Only our exact,
    // deterministic activation receipt may be replayed.
    if (state.subscription && !(subscriptionReceiptId && state.subscriptionReceipts && state.subscriptionReceipts[subscriptionReceiptId])) fail(409, 'TRIAL_SUBSCRIPTION_EXISTS');
    return { family, state };
  }

  async function reserveFamily(claim) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const { family, state } = await inspectEligibleFamily(claim.accountId, claim.familyId, claim.claimId, claim.subscriptionReceiptId);
      if (state.trialClaim) {
        return;
      }
      state.trialClaim = { claimId: claim.claimId, accountId: claim.accountId, policyVersion: claim.policy.version, reservedAt: claim.startedAt };
      if (await familyStore.cas(claim.familyId, family.rev || 0, { rev: (family.rev || 0) + 1, sealed: encryption.seal(state, `family:${claim.familyId}`) })) return;
    }
    fail(409, 'RETRY_CONCURRENT_CHANGE');
  }

  async function ensureFunding(claim) {
    await inspectEligibleFamily(claim.accountId, claim.familyId, claim.claimId, claim.subscriptionReceiptId);
    const value = { owner: claim.accountId, kind: 'family', familyId: claim.familyId, weeklyLimit: claim.policy.weeklyLimit,
      startsAt: claim.startedAt, expiresAt: claim.subscriptionExpiresAt, trialClaimId: claim.claimId };
    try {
      await budget.provision(claim.fundingId, value);
    } catch (error) {
      if (error.code !== 'FUNDING_EXISTS') throw error;
      const existing = await fundingStore.get(claim.fundingId);
      if (!existing) throw error;
      const state = encryption.open(existing.sealed, `funding:${claim.fundingId}`);
      if (state.owner !== value.owner || state.kind !== value.kind || state.familyId !== value.familyId || state.weeklyLimit !== value.weeklyLimit ||
          state.startsAt !== value.startsAt || state.expiresAt !== value.expiresAt || state.trialClaimId !== value.trialClaimId) fail(409, 'TRIAL_FUNDING_CONFLICT');
    }
    await budget.addPack(claim.fundingId, { id: claim.packId, type: 'trial', amount: claim.policy.trialUnits,
      startsAt: claim.startedAt, expiresAt: claim.trialExpiresAt });
  }

  async function markComplete(accountId, claimId) {
    return mutateAccount(accountId, state => {
      if (!state.trialClaim || state.trialClaim.claimId !== claimId) fail(409, 'TRIAL_CLAIM_CORRUPT');
      if (state.trialClaim.status === 'complete') return { noWrite: true, value: clone(state.trialClaim) };
      state.trialClaim.status = 'complete';
      state.trialClaim.completedAt = now();
      return { value: clone(state.trialClaim) };
    });
  }

  return {
    async claim(accountId, familyId) {
      if (!configuredPolicy) fail(503, 'TRIAL_NOT_CONFIGURED');
      if (!valid(accountId) || !valid(familyId)) fail(400, 'INVALID_TRIAL_CLAIM');
      if (!accountEligibility || typeof accountEligibility.isVerified !== 'function' || !(await accountEligibility.isVerified(accountId))) fail(403, 'ACCOUNT_VERIFICATION_REQUIRED');
      const claimId = deterministicId('trial', accountId, familyId);
      await inspectEligibleFamily(accountId, familyId, claimId, deterministicId('trial-subscription', claimId));
      const claim = await reserveAccount(accountId, familyId);
      if (claim.status === 'complete') return { claimId: claim.claimId, fundingId: claim.fundingId, status: claim.status };
      await reserveFamily(claim);
      await ensureFunding(claim);
      await subscription.activate({ familyId, payerId: accountId, administratorId: accountId, receiptId: claim.subscriptionReceiptId,
        startsAt: claim.startedAt, expiresAt: claim.subscriptionExpiresAt, expectedOwner: accountId, expectedExclusiveReceiptId: claim.subscriptionReceiptId });
      await budget.activateTrial(claim.fundingId, claim.claimId);
      const complete = await markComplete(accountId, claim.claimId);
      return { claimId: complete.claimId, fundingId: complete.fundingId, status: complete.status };
    }
  };
}

module.exports = { createCareTrialClaim, validatePolicy };

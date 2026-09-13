'use strict';
const { fail } = require('./carePolicy');
// Trusted provisioning/payment adapter only. No HTTP route accepts subscription
// activation or payer claims from a client. Renewals preserve the administrator.
function createCareSubscription({ store, encryption }) {
  return {
    async activate({ familyId, payerId, administratorId, receiptId, startsAt, expiresAt }) {
      if (![payerId, receiptId].every(v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v)) ||
          !Number.isSafeInteger(startsAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= startsAt) fail(400, 'INVALID_SUBSCRIPTION');
      for (let attempt = 0; attempt < 8; attempt++) {
        const family = await store.getFamily(familyId);
        if (!family) fail(404, 'FAMILY_NOT_FOUND');
        const state = encryption.open(family.sealed, `family:${familyId}`);
        state.subscriptionReceipts = state.subscriptionReceipts || {};
        const receipt = JSON.stringify({ payerId, administratorId: administratorId || payerId, startsAt, expiresAt });
        if (state.subscriptionReceipts[receiptId]) {
          if (state.subscriptionReceipts[receiptId] !== receipt) fail(409, 'SUBSCRIPTION_RECEIPT_REUSED');
          return { ok: true };
        }
        const first = !state.subscription;
        if (!first && expiresAt <= state.subscription.expiresAt) fail(400, 'INVALID_RENEWAL');
        state.subscription = { startsAt: first ? startsAt : state.subscription.startsAt, expiresAt };
        state.payerId = payerId;
        state.subscriptionReceipts[receiptId] = receipt;
        const owner = first ? administratorId || payerId : family.owner;
        if (typeof owner !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(owner)) fail(400, 'INVALID_ADMINISTRATOR');
        if (await store.casFamily(familyId, family.rev || 0, { owner, rev: (family.rev || 0) + 1, sealed: encryption.seal(state, `family:${familyId}`) })) return { ok: true };
      }
      fail(409, 'RETRY_CONCURRENT_CHANGE');
    }
  };
}
module.exports = { createCareSubscription };

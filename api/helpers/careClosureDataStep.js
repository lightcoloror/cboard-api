'use strict';

const mongoose = require('mongoose');
const { TRANSACTION_OPTIONS } = require('./careFamilyLifecycle');
const { pruneAccountReferences } = require('./careClosureAccountStep');
const { fail } = require('./carePolicy');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const ids = value => Array.isArray(value) && value.every(validId) && new Set(value).size === value.length;
const same = (a, b) => ids(a) && ids(b) && a.length === b.length && a.every(id => b.includes(id));
const matched = result => Number(result && (result.matchedCount === undefined ? result.n : result.matchedCount)) === 1;
const reconcile = () => fail(503, 'CLOSURE_RECONCILIATION_REQUIRED');

// Reuse the durable manifest and Mongo transaction. The terminal state here
// means family data only; user/session/legacy account cleanup is a later stage.
function createCareClosureDataStep({ connection = mongoose.connection,
  encryption = require('./careCrypto').fromEnvironment(), now = Date.now } = {}) {
  const jobs = connection.collection('careclosurejobs');
  const lifecycles = connection.collection('careaccountlifecycles');
  const families = connection.collection('carefamilies');
  const profiles = connection.collection('careprofiles');
  const fundings = connection.collection('carefundings');
  const accounts = connection.collection('careaccounts');
  const communicators = connection.collection('communicators');
  function open(sealed, context) {
    try { const state = encryption.open(sealed, context); if (!record(state)) reconcile(); return state; }
    catch (_) { reconcile(); }
  }
  async function apply(owner, operationId, session) {
    const job = await jobs.findOne({ _id: operationId, owner }, { session });
    if (!job) fail(503, 'CLOSURE_JOB_UNAVAILABLE');
    if (!['accounts_cleaned', 'family_data_cleaned'].includes(job.status)) fail(409, 'CLOSURE_ACCOUNTS_NOT_COMPLETE');
    const plan = open(job.sealed, `closure:${operationId}`);
    if (plan.version !== 1 || plan.owner !== owner || !ids(plan.familyIds) || !plan.familyIds.length ||
      !ids(plan.profileIds) || !ids(plan.familyFundingIds) || !ids(plan.relatedAccountIds) ||
      !plan.relatedAccountIds.includes(owner) || !Array.isArray(plan.media) ||
      !Array.isArray(plan.pendingUsage) || !Array.isArray(plan.institutionAdminIds) || plan.institutionAdminIds.length ||
      job.mediaCursor !== plan.media.length || job.accountCursor !== plan.relatedAccountIds.length) reconcile();
    const lifecycle = await lifecycles.findOne({ _id: owner }, { session });
    const closure = lifecycle && lifecycle.closure;
    if (!lifecycle || lifecycle.status !== 'closing' || !closure || closure.status !== 'closing' ||
      closure.owner !== owner || closure.operationId !== operationId || !same(closure.familyIds, plan.familyIds)) {
      fail(503, 'CLOSURE_SCOPE_MISMATCH');
    }
    const familyDocs = await families.find({ _id: { $in: plan.familyIds } }, { session }).limit(plan.familyIds.length + 1).toArray();
    if (!same(familyDocs.map(doc => doc._id), plan.familyIds)) fail(503, 'CLOSURE_SCOPE_MISMATCH');
    const expectedStatus = job.status === 'family_data_cleaned' ? 'closed' : 'closing';
    for (const family of familyDocs) {
      if (family.owner !== owner || !family.closure || family.closure.owner !== owner ||
        family.closure.operationId !== operationId || family.closure.status !== expectedStatus) fail(503, 'CLOSURE_SCOPE_MISMATCH');
    }
    if (job.status === 'family_data_cleaned') return { status: job.status, count: 0 };
    const profileDocs = await profiles.find({ familyId: { $in: plan.familyIds } }, { session })
      .project({ _id: 1, familyId: 1 }).limit(plan.profileIds.length + 1).toArray();
    if (!same(profileDocs.map(doc => doc._id), plan.profileIds)) fail(503, 'CLOSURE_SCOPE_MISMATCH');
    const fundingDocs = await fundings.find({ kind: 'family', familyId: { $in: plan.familyIds } }, { session })
      .limit(plan.familyFundingIds.length + 1).toArray();
    if (!same(fundingDocs.map(doc => doc._id), plan.familyFundingIds)) fail(503, 'CLOSURE_SCOPE_MISMATCH');
    for (const funding of fundingDocs) {
      const state = open(funding.sealed, `funding:${funding._id}`);
      if (!record(state.receipts) || Object.values(state.receipts).some(receipt =>
        !record(receipt) || !['settled', 'released'].includes(receipt.status))) reconcile();
    }
    for (const pending of plan.pendingUsage) {
      if (!record(pending) || ![pending.fundingId, pending.actor, pending.requestId, pending.profileId].every(validId)) reconcile();
      const funding = await fundings.findOne({ _id: pending.fundingId }, { session });
      if (!funding) reconcile();
      const state = open(funding.sealed, `funding:${funding._id}`);
      const receipt = state.receipts && state.receipts[`${pending.actor}:${pending.requestId}`];
      if (!record(receipt) || receipt.actor !== pending.actor || receipt.requestId !== pending.requestId ||
        receipt.profileId !== pending.profileId || !['settled', 'released'].includes(receipt.status)) reconcile();
    }
    for (const family of familyDocs) {
      const state = open(family.sealed, `family:${family._id}`);
      if (state.mediaQuota !== undefined && (!record(state.mediaQuota) || !record(state.mediaQuota.reservations) ||
        Object.values(state.mediaQuota.reservations).some(reservation => !record(reservation) ||
          !['committed', 'released'].includes(reservation.status)))) reconcile();
    }
    for (const id of plan.relatedAccountIds) {
      const account = await accounts.findOne({ _id: id }, { session });
      if (account && pruneAccountReferences(open(account.sealed, `account:${id}`), plan.profileIds).changed) reconcile();
    }
    const markers = await communicators.find({ careFamilyId: { $in: plan.familyIds } }, { session }).limit(1001).toArray();
    if (markers.length > 1000 || markers.some(marker => !profileDocs.some(profile =>
      profile._id === marker.careProfileId && profile.familyId === marker.careFamilyId) ||
      marker.rootBoard !== '' || !Array.isArray(marker.boards) || marker.boards.length)) reconcile();
    // Each communicator must carry both markers. Neither an email match nor a
    // profile id by itself authorizes deleting legacy or another family's data.
    for (const profile of profileDocs) {
      await communicators.deleteMany({ careFamilyId: profile.familyId, careProfileId: profile._id }, { session });
    }
    await profiles.deleteMany({ _id: { $in: plan.profileIds }, familyId: { $in: plan.familyIds } }, { session });
    await fundings.deleteMany({ _id: { $in: plan.familyFundingIds }, kind: 'family', familyId: { $in: plan.familyIds } }, { session });
    const at = now();
    for (const family of familyDocs) {
      if (!matched(await families.replaceOne({ _id: family._id, owner, 'closure.operationId': operationId,
        'closure.status': 'closing' }, { _id: family._id, owner,
        closure: { status: 'closed', owner, operationId, at: family.closure.at, completedAt: at } }, { session }))) {
        fail(409, 'CLOSURE_DATA_RETRY_REQUIRED');
      }
    }
    if (!matched(await jobs.updateOne({ _id: operationId, owner, rev: job.rev, status: 'accounts_cleaned' }, {
      $set: { status: 'family_data_cleaned', updatedAt: at }, $inc: { rev: 1 }
    }, { session }))) fail(409, 'CLOSURE_DATA_RETRY_REQUIRED');
    return { status: 'family_data_cleaned', count: familyDocs.length };
  }
  return { async run(owner, operationId) {
    if (!validId(owner) || !validId(operationId)) fail(400, 'INVALID_CLOSURE_JOB');
    const session = await connection.startSession();
    let result;
    try { await session.withTransaction(async current => { result = await apply(owner, operationId, current); }, TRANSACTION_OPTIONS); }
    finally { await session.endSession(); }
    return result;
  } };
}
module.exports = { createCareClosureDataStep };

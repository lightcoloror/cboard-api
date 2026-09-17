'use strict';

const mongoose = require('mongoose');
const careCrypto = require('./careCrypto');

const VALID_STATUSES = new Set(['prepared', 'media_cleanup', 'media_cleaned']);
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const validId = value => typeof value === 'string' && idPattern.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const changed = result => Number(result && (result.matchedCount !== undefined ? result.matchedCount : result.n)) === 1;

function failure(status, code) {
  throw Object.assign(new Error(code), { status, code });
}

function reconciliation() {
  failure(503, 'CLOSURE_RECONCILIATION_REQUIRED');
}

function sortIds(values) {
  return values.map(String).sort();
}

function sameIds(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function createCareClosureMediaStep({
  connection = mongoose.connection,
  encryption = careCrypto.fromEnvironment(),
  media,
  maxPerRun = 20,
  now = () => Date.now()
} = {}) {
  if (!Number.isSafeInteger(maxPerRun) || maxPerRun < 1) throw new TypeError('Invalid media cleanup limit');
  if (!media || typeof media.remove !== 'function') throw new TypeError('Media remove adapter is required');
  const jobs = connection.collection('careclosurejobs');
  const accounts = connection.collection('careaccountlifecycles');
  const families = connection.collection('carefamilies');
  const fundings = connection.collection('carefundings');

  async function loadJob(owner, operationId) {
    const job = await jobs.findOne({ _id: operationId, owner });
    if (!job) failure(503, 'CLOSURE_JOB_UNAVAILABLE');
    if (!VALID_STATUSES.has(job.status)) failure(503, 'CLOSURE_MEDIA_RETRY_REQUIRED');
    let plan;
    try {
      plan = encryption.open(job.sealed, `closure:${operationId}`);
    } catch (_) {
      reconciliation();
    }
    if (!plan || plan.owner !== owner ||
      (plan.operationId !== undefined && plan.operationId !== operationId) ||
      !Array.isArray(plan.familyIds) || new Set(plan.familyIds).size !== plan.familyIds.length ||
      plan.familyIds.some(id => !validId(id)) || !Array.isArray(plan.media) ||
      !Array.isArray(plan.pendingUsage) || !Array.isArray(plan.pendingUploads) ||
      !Array.isArray(plan.institutionAdminIds)) reconciliation();
    return { job, plan };
  }

  async function validateScope(owner, operationId, plan) {
    const account = await accounts.findOne({ _id: owner });
    const closure = account && account.closure;
    if (!account || account.status !== 'closing' || !closure || closure.status !== 'closing' ||
      closure.owner !== owner || closure.operationId !== operationId || !Array.isArray(closure.familyIds) ||
      !sameIds(sortIds(closure.familyIds), sortIds(plan.familyIds))) failure(503, 'CLOSURE_SCOPE_MISMATCH');
    for (const familyId of plan.familyIds) {
      const family = await families.findOne({ _id: familyId });
      const familyClosure = family && family.closure;
      if (!family || family.owner !== owner || !familyClosure || familyClosure.status !== 'closing' ||
        familyClosure.owner !== owner || familyClosure.operationId !== operationId) {
        failure(503, 'CLOSURE_SCOPE_MISMATCH');
      }
    }
  }

  function decrypt(envelope, context) {
    try { return encryption.open(envelope, context); } catch (_) { reconciliation(); }
  }

  async function pendingUsageBlocks(plan) {
    for (const item of plan.pendingUsage) {
      if (!item || !validId(item.fundingId) || !validId(item.actor) || !validId(item.requestId) || !validId(item.profileId)) reconciliation();
      const funding = await fundings.findOne({ _id: item.fundingId });
      if (!funding) reconciliation();
      const state = decrypt(funding.sealed, `funding:${item.fundingId}`);
      if (!state || !state.receipts || typeof state.receipts !== 'object' || Array.isArray(state.receipts)) reconciliation();
      const receipt = Object.values(state.receipts).find(value => value && value.actor === item.actor &&
        value.requestId === item.requestId && value.profileId === item.profileId);
      if (!receipt || !['reserved', 'settled', 'released'].includes(receipt.status)) reconciliation();
      if (receipt.status === 'reserved') return true;
    }
    return false;
  }

  async function pendingUploadBlocks(plan) {
    const mediaKeys = new Set(plan.media.map(item => item && `${item.profileId}\u0000${item.mediaId}`));
    for (const item of plan.pendingUploads) {
      if (!item || !validId(item.familyId) || !validId(item.key) || !validId(item.profileId) || !validId(item.mediaId)) reconciliation();
      const family = await families.findOne({ _id: item.familyId });
      if (!family) reconciliation();
      const state = decrypt(family.sealed, `family:${item.familyId}`);
      const quota = state && state.mediaQuota;
      const reservation = quota && quota.reservations && quota.reservations[item.key];
      if (!reservation) reconciliation();
      if (!['reserved', 'committed', 'released'].includes(reservation.status)) reconciliation();
      if (reservation.status === 'reserved') return true;
      if (reservation.status === 'committed' && !mediaKeys.has(`${item.profileId}\u0000${item.mediaId}`)) reconciliation();
    }
    return false;
  }

  async function currentJob(owner, operationId) {
    const current = await jobs.findOne({ _id: operationId, owner });
    if (!current) failure(503, 'CLOSURE_JOB_UNAVAILABLE');
    return current;
  }

  async function run(owner, operationId) {
    if (!validId(owner) || !validId(operationId)) failure(400, 'INVALID_CLOSURE_JOB');
    const { job, plan } = await loadJob(owner, operationId);
    await validateScope(owner, operationId, plan);
    if (plan.institutionAdminIds.length) return { status: 'waiting', count: 0 };
    if (await pendingUsageBlocks(plan) || await pendingUploadBlocks(plan)) return { status: 'waiting', count: 0 };
    if (plan.media.some(item => !item || !validId(item.familyId) || !plan.familyIds.includes(item.familyId) || !validId(item.profileId) ||
      !validId(item.mediaId) || typeof item.blob !== 'string' || !item.blob)) reconciliation();
    const mediaEntries = plan.media.slice().sort((left, right) =>
      [left.familyId, left.profileId, left.mediaId, left.blob].map(String).join('\u0000').localeCompare(
        [right.familyId, right.profileId, right.mediaId, right.blob].map(String).join('\u0000')));
    if (mediaEntries.some(item => !item || !validId(item.familyId) || !validId(item.profileId) ||
      !validId(item.mediaId) || typeof item.blob !== 'string' || !item.blob)) reconciliation();
    const cursor = job.mediaCursor === undefined ? 0 : job.mediaCursor;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > mediaEntries.length) reconciliation();
    let count = 0;
    if (job.status === 'media_cleaned' && cursor === mediaEntries.length) return { status: 'media_cleaned', count: 0 };
    if (cursor === mediaEntries.length && !mediaEntries.length) {
      const result = await jobs.updateOne({ _id: operationId, owner, rev: job.rev }, {
        $set: { mediaCursor: 0, status: 'media_cleaned', updatedAt: now() }, $inc: { rev: 1 }
      });
      if (!changed(result)) return { status: (await currentJob(owner, operationId)).status, count: 0 };
      return { status: 'media_cleaned', count: 0 };
    }
    const end = Math.min(mediaEntries.length, cursor + maxPerRun);
    for (let index = cursor; index < end; index += 1) {
      try { await media.remove(mediaEntries[index].blob); } catch (_) { failure(503, 'CLOSURE_MEDIA_RETRY_REQUIRED'); }
      const next = index + 1;
      const result = await jobs.updateOne({ _id: operationId, owner, rev: job.rev }, {
        $set: { mediaCursor: next, status: next === mediaEntries.length ? 'media_cleaned' : 'media_cleanup', updatedAt: now() },
        $inc: { rev: 1 }
      });
      if (!changed(result)) return { status: (await currentJob(owner, operationId)).status, count };
      job.rev += 1;
      count += 1;
    }
    return { status: end === mediaEntries.length ? 'media_cleaned' : 'media_cleanup', count };
  }

  return { run };
}

module.exports = { createCareClosureMediaStep };

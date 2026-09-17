'use strict';

const mongoose = require('mongoose');
const { TRANSACTION_OPTIONS } = require('./careFamilyLifecycle');
const { fail } = require('./carePolicy');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const matched = result => Number(result && (result.matchedCount === undefined ? result.n : result.matchedCount)) === 1;
const unavailable = () => fail(503, 'CLOSURE_RECONCILIATION_REQUIRED');
const idList = value => Array.isArray(value) && value.every(validId) && new Set(value).size === value.length;
const sameIds = (a, b) => idList(a) && idList(b) && a.length === b.length && a.every(id => b.includes(id));

// Preserve the account and all unrelated-family data. Receipts also contain
// favorite contents, so removing only the favorites map would leave a copy.
function pruneAccountReferences(state, profileIds) {
  if (!record(state) || !idList(profileIds)) unavailable();
  const targets = new Set(profileIds);
  const next = JSON.parse(JSON.stringify(state));
  if (next.selectedProfileId !== undefined && next.selectedProfileId !== null && !validId(next.selectedProfileId)) unavailable();
  if (targets.has(next.selectedProfileId)) next.selectedProfileId = null;
  for (const field of ['favorites', 'favoriteReceipts']) {
    if (next[field] === undefined) continue;
    if (!record(next[field])) unavailable();
    for (const [key, value] of Object.entries(next[field])) {
      if (!record(value)) unavailable();
      const resource = field === 'favorites' ? value : value.result && value.result.resource;
      if (!record(resource) || !validId(resource.profileId)) unavailable();
      if (targets.has(resource.profileId)) delete next[field][key];
    }
  }
  if (next.favoriteAudit !== undefined) {
    if (!Array.isArray(next.favoriteAudit) || next.favoriteAudit.some(item => !record(item) || !validId(item.profileId))) unavailable();
    next.favoriteAudit = next.favoriteAudit.filter(item => !targets.has(item.profileId));
  }
  return { state: next, changed: JSON.stringify(state) !== JSON.stringify(next) };
}

// Internal stage only: each account edit and its progress marker commit in
// the same existing Mongo transaction. No User, Family or Profile is deleted.
function createCareClosureAccountStep({ connection = mongoose.connection,
  encryption = require('./careCrypto').fromEnvironment(), maxPerRun = 20, now = Date.now } = {}) {
  if (!Number.isSafeInteger(maxPerRun) || maxPerRun < 1 || maxPerRun > 1000) throw new TypeError('Invalid account cleanup limit');
  const jobs = connection.collection('careclosurejobs');
  const lifecycles = connection.collection('careaccountlifecycles');
  const families = connection.collection('carefamilies');
  const profiles = connection.collection('careprofiles');
  const accounts = connection.collection('careaccounts');
  function open(sealed, context) {
    try { return encryption.open(sealed, context); } catch (_) { unavailable(); }
  }
  async function advance(owner, operationId, session) {
    const job = await jobs.findOne({ _id: operationId, owner }, { session });
    if (!job) fail(503, 'CLOSURE_JOB_UNAVAILABLE');
    if (!['media_cleaned', 'account_cleanup', 'accounts_cleaned'].includes(job.status)) fail(409, 'CLOSURE_MEDIA_NOT_COMPLETE');
    const plan = open(job.sealed, `closure:${operationId}`);
    if (!record(plan) || plan.version !== 1 || plan.owner !== owner || !idList(plan.familyIds) ||
      !plan.familyIds.length || !idList(plan.profileIds) || !idList(plan.relatedAccountIds) ||
      !plan.relatedAccountIds.includes(owner)) unavailable();
    const lifecycle = await lifecycles.findOne({ _id: owner }, { session });
    const closure = lifecycle && lifecycle.closure;
    if (!lifecycle || lifecycle.status !== 'closing' || !closure || closure.status !== 'closing' ||
      closure.owner !== owner || closure.operationId !== operationId || !sameIds(closure.familyIds, plan.familyIds)) {
      fail(503, 'CLOSURE_SCOPE_MISMATCH');
    }
    for (const id of plan.familyIds) {
      const family = await families.findOne({ _id: id }, { session });
      if (!family || family.owner !== owner || !family.closure || family.closure.status !== 'closing' ||
        family.closure.owner !== owner || family.closure.operationId !== operationId) fail(503, 'CLOSURE_SCOPE_MISMATCH');
    }
    for (const id of plan.profileIds) {
      const profile = await profiles.findOne({ _id: id }, { session });
      if (!profile || !plan.familyIds.includes(profile.familyId)) fail(503, 'CLOSURE_SCOPE_MISMATCH');
    }
    const ids = plan.relatedAccountIds.slice().sort();
    const cursor = job.accountCursor === undefined ? 0 : job.accountCursor;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > ids.length || !Number.isSafeInteger(job.rev)) unavailable();
    if (job.status === 'accounts_cleaned') {
      if (cursor !== ids.length) unavailable();
      return { status: job.status, count: 0 };
    }
    if (cursor < ids.length) {
      const id = ids[cursor];
      const account = await accounts.findOne({ _id: id }, { session });
      if (account) {
        if (!Number.isSafeInteger(account.rev) || account.rev < 0) unavailable();
        const result = pruneAccountReferences(open(account.sealed, `account:${id}`), plan.profileIds);
        if (result.changed && !matched(await accounts.updateOne({ _id: id, rev: account.rev }, {
          $set: { sealed: encryption.seal(result.state, `account:${id}`) }, $inc: { rev: 1 }
        }, { session }))) fail(409, 'CLOSURE_ACCOUNT_RETRY_REQUIRED');
      }
    }
    const next = Math.min(cursor + 1, ids.length);
    const status = next === ids.length ? 'accounts_cleaned' : 'account_cleanup';
    if (!matched(await jobs.updateOne({ _id: operationId, owner, rev: job.rev }, {
      $set: { accountCursor: next, status, updatedAt: now() }, $inc: { rev: 1 }
    }, { session }))) fail(409, 'CLOSURE_ACCOUNT_RETRY_REQUIRED');
    return { status, count: cursor < ids.length ? 1 : 0 };
  }
  return { async run(owner, operationId) {
    if (!validId(owner) || !validId(operationId)) fail(400, 'INVALID_CLOSURE_JOB');
    let count = 0;
    for (let index = 0; index < maxPerRun; index++) {
      const session = await connection.startSession();
      let result;
      try {
        await session.withTransaction(async current => { result = await advance(owner, operationId, current); }, TRANSACTION_OPTIONS);
      } finally { await session.endSession(); }
      count += result.count;
      if (result.status === 'accounts_cleaned') return { status: result.status, count };
    }
    return { status: 'account_cleanup', count };
  } };
}

module.exports = { pruneAccountReferences, createCareClosureAccountStep };

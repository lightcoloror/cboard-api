'use strict';

const mongoose = require('mongoose');
const { TRANSACTION_OPTIONS } = require('./careFamilyLifecycle');
const { fail } = require('./carePolicy');
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const matched = result => Number(result && (result.matchedCount === undefined ? result.n : result.matchedCount)) === 1;
const reconcile = () => fail(503, 'CLOSURE_RECONCILIATION_REQUIRED');

// Remove active memberships only. Patient content and settled accounting
// records remain with their family/institution, never with the departing actor.
function createCareClosureAccessStep({ connection = mongoose.connection,
  encryption = require('./careCrypto').fromEnvironment(), maxPerRun = 20, now = Date.now } = {}) {
  if (!Number.isSafeInteger(maxPerRun) || maxPerRun < 1 || maxPerRun > 1000) throw new TypeError('Invalid access cleanup limit');
  const jobs = connection.collection('careclosurejobs');
  const lifecycles = connection.collection('careaccountlifecycles');
  const families = connection.collection('carefamilies');
  const profiles = connection.collection('careprofiles');
  const fundings = connection.collection('carefundings');
  function open(sealed, context) {
    try { const state = encryption.open(sealed, context); if (!record(state)) reconcile(); return state; }
    catch (_) { reconcile(); }
  }
  async function advance(owner, operationId, session) {
    const job = await jobs.findOne({ _id: operationId, owner }, { session });
    if (!job) fail(503, 'CLOSURE_JOB_UNAVAILABLE');
    if (!['family_data_cleaned', 'access_cleanup', 'access_revoked'].includes(job.status)) fail(409, 'CLOSURE_DATA_NOT_COMPLETE');
    const lifecycle = await lifecycles.findOne({ _id: owner }, { session });
    if (!lifecycle || lifecycle.status !== 'closing' || !lifecycle.closure ||
      lifecycle.closure.owner !== owner || lifecycle.closure.operationId !== operationId || lifecycle.closure.status !== 'closing') {
      fail(503, 'CLOSURE_SCOPE_MISMATCH');
    }
    if (job.status === 'access_revoked') return { status: job.status, count: 0 };
    const profile = await profiles.findOne({ members: owner }, { session });
    const funding = profile ? null : await fundings.findOne({ members: owner }, { session });
    let count = 0;
    if (profile) {
      const family = await families.findOne({ _id: profile.familyId }, { session });
      if (!family || family.owner === owner) reconcile();
      const state = open(profile.sealed, `profile:${profile._id}`);
      if (!record(state.grants) || !Array.isArray(profile.members) || !Number.isSafeInteger(profile.rev)) reconcile();
      delete state.grants[owner];
      if (state.relationships !== undefined) {
        if (!record(state.relationships)) reconcile();
        delete state.relationships[owner];
      }
      if (state.invites !== undefined) {
        if (!record(state.invites)) reconcile();
        for (const [id, invitation] of Object.entries(state.invites)) {
          if (!record(invitation)) reconcile();
          if (invitation.acceptedBy === owner) delete state.invites[id];
        }
      }
      if (!matched(await profiles.updateOne({ _id: profile._id, rev: profile.rev }, {
        $set: { sealed: encryption.seal(state, `profile:${profile._id}`),
          members: profile.members.filter(member => member !== owner) }, $inc: { rev: 1 }
      }, { session }))) fail(409, 'CLOSURE_ACCESS_RETRY_REQUIRED');
      count = 1;
    } else if (funding) {
      if (funding.owner === owner) fail(409, 'FUNDING_TRANSFER_REQUIRED');
      const state = open(funding.sealed, `funding:${funding._id}`);
      if (!record(state.grants) || !record(state.receipts) || !Array.isArray(funding.members) ||
        !Number.isSafeInteger(funding.rev)) reconcile();
      if (Object.values(state.receipts).some(receipt => !record(receipt) ||
        receipt.actor === owner && !['settled', 'released'].includes(receipt.status))) reconcile();
      delete state.grants[owner];
      if (!matched(await fundings.updateOne({ _id: funding._id, rev: funding.rev }, {
        $set: { sealed: encryption.seal(state, `funding:${funding._id}`),
          members: funding.members.filter(member => member !== owner) }, $inc: { rev: 1 }
      }, { session }))) fail(409, 'CLOSURE_ACCESS_RETRY_REQUIRED');
      count = 1;
    }
    const status = count ? 'access_cleanup' : 'access_revoked';
    if (!matched(await jobs.updateOne({ _id: operationId, owner, rev: job.rev }, {
      $set: { status, updatedAt: now() }, $inc: { rev: 1, revokedMemberships: count }
    }, { session }))) fail(409, 'CLOSURE_ACCESS_RETRY_REQUIRED');
    return { status, count };
  }
  return { async run(owner, operationId) {
    if (!validId(owner) || !validId(operationId)) fail(400, 'INVALID_CLOSURE_JOB');
    let count = 0;
    for (let index = 0; index < maxPerRun; index++) {
      const session = await connection.startSession();
      let result;
      try { await session.withTransaction(async current => { result = await advance(owner, operationId, current); }, TRANSACTION_OPTIONS); }
      finally { await session.endSession(); }
      count += result.count;
      if (result.status === 'access_revoked') return { status: result.status, count };
    }
    return { status: 'access_cleanup', count };
  } };
}
module.exports = { createCareClosureAccessStep };

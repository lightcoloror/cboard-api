'use strict';

const mongoose = require('mongoose');
const { TRANSACTION_OPTIONS } = require('./careFamilyLifecycle');
const { fail } = require('./carePolicy');
const changed = result => Number(result && (result.matchedCount === undefined ? result.n : result.matchedCount)) === 1;
const deleted = result => Number(result && (result.deletedCount === undefined ? result.n : result.deletedCount)) === 1;

// Internal adapter boundary: callers must supply the existing legacy cleanup
// and session revocation services. No controller or scheduler invokes this yet.
function createCareClosureFinalize({ connection = mongoose.connection,
  encryption = require('./careCrypto').fromEnvironment(), cleanup, revokeSessions, now = Date.now } = {}) {
  if (typeof cleanup !== 'function' || typeof revokeSessions !== 'function') throw new TypeError('Account cleanup adapters required');
  const jobs = connection.collection('careclosurejobs');
  const lifecycles = connection.collection('careaccountlifecycles');
  const users = connection.collection('users');
  const accounts = connection.collection('careaccounts');
  async function transaction(fn) {
    const session = await connection.startSession(); let result;
    try { await session.withTransaction(async current => { result = await fn(current); }, TRANSACTION_OPTIONS); }
    finally { await session.endSession(); }
    return result;
  }
  async function read(owner, operationId, session) {
    const job = await jobs.findOne({ _id: operationId, owner }, { session });
    if (!job) fail(503, 'CLOSURE_JOB_UNAVAILABLE');
    if (!['access_revoked', 'account_cleanup_pending', 'complete'].includes(job.status)) fail(409, 'CLOSURE_ACCESS_NOT_COMPLETE');
    const account = await lifecycles.findOne({ _id: owner }, { session });
    const status = job.status === 'complete' ? 'closed' : 'closing';
    if (!account || account.status !== status || !account.closure || account.closure.owner !== owner ||
      account.closure.operationId !== operationId || account.closure.status !== status) fail(503, 'CLOSURE_SCOPE_MISMATCH');
    return job;
  }
  async function assertNoAccess(owner, session) {
    if (await connection.collection('carefamilies').findOne({ owner, 'closure.status': { $ne: 'closed' } }, { session }) ||
      await connection.collection('careprofiles').findOne({ members: owner }, { session }) ||
      await connection.collection('carefundings').findOne({ $or: [{ owner }, { members: owner }] }, { session })) {
      fail(503, 'CLOSURE_ACCESS_REMAINS');
    }
  }
  return { async run(owner, operationId) {
    if (typeof owner !== 'string' || !/^[a-f0-9]{24}$/i.test(owner) || typeof operationId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(operationId)) fail(400, 'INVALID_CLOSURE_JOB');
    const userId = new mongoose.Types.ObjectId(owner);
    const cleanupClaim = require('crypto').randomBytes(16).toString('hex');
    const prepared = await transaction(async session => {
      const job = await read(owner, operationId, session);
      const user = await users.findOne({ _id: userId }, { session });
      if (job.status === 'complete') {
        if (user) fail(503, 'CLOSURE_USER_REAPPEARED');
        return { complete: true };
      }
      // Do not allow two legacy email-based cleanups to outlive User deletion.
      // An interrupted claimant requires reconciliation, never a TTL takeover.
      if (job.cleanupClaim) fail(409, 'CLOSURE_CLEANUP_IN_PROGRESS');
      await assertNoAccess(owner, session);
      if (!user || typeof user.email !== 'string' || !user.email.trim()) fail(503, 'CLOSURE_USER_UNAVAILABLE');
      let email = user.email;
      if (job.status === 'account_cleanup_pending') {
        try { email = encryption.open(job.accountCleanup, `closure-account:${operationId}`).email; }
        catch (_) { fail(503, 'CLOSURE_RECONCILIATION_REQUIRED'); }
        if (email !== user.email) fail(409, 'CLOSURE_USER_CHANGED');
      }
      if (!changed(await jobs.updateOne({ _id: operationId, owner, rev: job.rev, status: job.status, cleanupClaim: { $exists: false } }, {
        $set: { status: 'account_cleanup_pending', cleanupClaim, updatedAt: now(),
          accountCleanup: encryption.seal({ email }, `closure-account:${operationId}`) }, $inc: { rev: 1 }
      }, { session }))) fail(409, 'CLOSURE_FINALIZE_RETRY_REQUIRED');
      return { email };
    });
    if (prepared.complete) return { status: 'complete', accountDeleted: true };
    // A failed or lost cleanup leaves User and the claim intact. Reconciliation
    // must prove that worker/provider operations stopped before clearing it.
    await revokeSessions(owner);
    await cleanup({ id: owner, userEmail: prepared.email });
    return transaction(async session => {
      const job = await read(owner, operationId, session);
      if (job.status === 'complete') return { status: 'complete', accountDeleted: true };
      if (job.status !== 'account_cleanup_pending' || job.cleanupClaim !== cleanupClaim) fail(409, 'CLOSURE_FINALIZE_RETRY_REQUIRED');
      await assertNoAccess(owner, session);
      if (await accounts.findOne({ _id: owner }, { session })) fail(503, 'CLOSURE_ACCOUNT_DATA_REMAINS');
      if (!deleted(await users.deleteOne({ _id: userId, email: prepared.email }, { session }))) fail(409, 'CLOSURE_USER_CHANGED');
      if (!changed(await lifecycles.updateOne({ _id: owner, status: 'closing', 'closure.operationId': operationId }, {
        $set: { status: 'closed', 'closure.status': 'closed', 'closure.completedAt': now() }, $inc: { lifecycleRev: 1 }
      }, { session }))) fail(409, 'CLOSURE_FINALIZE_RETRY_REQUIRED');
      if (!changed(await jobs.updateOne({ _id: operationId, owner, rev: job.rev, status: 'account_cleanup_pending' }, {
        $set: { status: 'complete', updatedAt: now() }, $unset: { sealed: '', accountCleanup: '', cleanupClaim: '' }, $inc: { rev: 1 }
      }, { session }))) fail(409, 'CLOSURE_FINALIZE_RETRY_REQUIRED');
      return { status: 'complete', accountDeleted: true };
    });
  } };
}
module.exports = { createCareClosureFinalize };

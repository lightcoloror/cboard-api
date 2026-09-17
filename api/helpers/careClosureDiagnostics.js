'use strict';

const { INCOMPLETE_STATUSES } = require('./careClosureWorker');
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const errorCode = value => typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value) ? value : null;

// Read only: no encrypted plan, owner identifier, media key or receipt capability is loaded.
async function inspectCareClosureJob({ connection, operationId, now = () => Date.now() }) {
  if (!validId(operationId)) throw Object.assign(new Error('Invalid closure operation'), { code: 'INVALID_CLOSURE_JOB' });
  const job = await connection.collection('careclosurejobs').findOne({ _id: operationId }, {
    projection: { _id: 0, status: 1, updatedAt: 1, nextAttemptAt: 1, lastAttemptAt: 1,
      lastErrorCode: 1, needsAttention: 1, cleanupClaim: 1 }
  });
  if (!job) throw Object.assign(new Error('Closure operation unavailable'), { code: 'CLOSURE_JOB_UNAVAILABLE' });
  const known = INCOMPLETE_STATUSES.includes(job.status) || job.status === 'complete';
  const code = errorCode(job.lastErrorCode);
  const claimPresent = Object.prototype.hasOwnProperty.call(job, 'cleanupClaim');
  const completed = job.status === 'complete';
  const invalidMetadata = (job.lastErrorCode !== undefined && !code) ||
    (job.needsAttention !== undefined && typeof job.needsAttention !== 'boolean');
  const requiresReview = !known || claimPresent || job.needsAttention === true ||
    invalidMetadata || (completed && Boolean(code)) ||
    Boolean(code && /CLAIM|CLEANUP_IN_PROGRESS|UPLOAD_PENDING|RECONCILIATION|SCOPE_MISMATCH/.test(code));
  const nextAttemptAt = timestamp(job.nextAttemptAt);
  const invalidSchedule = job.nextAttemptAt !== undefined && nextAttemptAt === null;
  const manualReview = requiresReview || invalidSchedule;
  const nextAction = manualReview ? 'operator_review' : completed ? 'none' :
    nextAttemptAt !== null && nextAttemptAt > now() ? 'wait_for_scheduled_attempt' : 'run_existing_worker';
  return {
    schema: 'care-closure-diagnostics.v1', readOnly: true,
    evidenceScope: 'persisted_job_metadata',
    cleanupStatus: known ? job.status : 'unknown',
    // Inconsistent completion markers never become proof of a completed deletion.
    accountDeleted: completed && !manualReview,
    needsAttention: manualReview,
    cleanupClaimPresent: claimPresent,
    lastErrorCode: code,
    updatedAt: timestamp(job.updatedAt), lastAttemptAt: timestamp(job.lastAttemptAt), nextAttemptAt,
    nextAction,
    automaticClaimReleaseAllowed: false
  };
}

module.exports = { inspectCareClosureJob };

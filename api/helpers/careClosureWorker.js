'use strict';

const mongoose = require('mongoose');
const { fail } = require('./carePolicy');

const INCOMPLETE_STATUSES = Object.freeze([
  'prepared',
  'media_cleanup',
  'media_cleaned',
  'account_cleanup',
  'accounts_cleaned',
  'family_data_cleaned',
  'access_cleanup',
  'access_revoked',
  'account_cleanup_pending'
]);
const stableCode = error =>
  error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : 'CLOSURE_WORKER_FAILED';
const needsAttention = code => /CLAIM|CLEANUP_IN_PROGRESS|UPLOAD_PENDING|RECONCILIATION/.test(code);
const changed = result => Number(result && (result.matchedCount === undefined ? result.n : result.matchedCount)) === 1;

function createCareClosureWorker({
  connection = mongoose.connection,
  runner,
  now = Date.now,
  maxJobs = 10,
  retryMs = 60000
} = {}) {
  if (!connection || typeof connection.collection !== 'function') {
    throw new TypeError('Closure worker connection is required');
  }
  if (!runner || typeof runner.run !== 'function') {
    throw new TypeError('Closure worker runner is required');
  }
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 100) {
    throw new TypeError('Invalid closure worker limit');
  }
  if (!Number.isSafeInteger(retryMs) || retryMs < 1 || retryMs > 86400000) {
    throw new TypeError('Invalid closure worker retry interval');
  }

  const jobs = connection.collection('careclosurejobs');
  let running = false;

  async function runBatch() {
    if (running) fail(409, 'CLOSURE_WORKER_BUSY');
    running = true;
    try {
      const at = now();
      const candidates = await jobs.find({
        status: { $in: INCOMPLETE_STATUSES },
        $or: [
          { nextAttemptAt: { $exists: false } },
          { nextAttemptAt: { $lte: at } }
        ]
      }, {
        projection: { _id: 1, owner: 1, status: 1, nextAttemptAt: 1 }
      }).sort({ nextAttemptAt: 1, updatedAt: 1, _id: 1 }).limit(maxJobs).toArray();
      const counts = {
        scanned: candidates.length,
        attempted: 0,
        completed: 0,
        deferred: 0,
        failed: 0,
        needsAttention: 0
      };
      for (const candidate of candidates) {
        counts.attempted += 1;
        const attemptedAt = now();
        let runnerError = null;
        try {
          await runner.run(candidate.owner, candidate._id);
        } catch (error) {
          runnerError = error;
        }
        if (runnerError) {
          const code = stableCode(runnerError);
          const schedule = await jobs.updateOne({ _id: candidate._id, owner: candidate.owner,
            status: { $in: INCOMPLETE_STATUSES } }, {
            $set: {
              nextAttemptAt: attemptedAt + retryMs,
              lastAttemptAt: attemptedAt,
              lastErrorCode: code,
              needsAttention: needsAttention(code)
            }
          });
          if (!changed(schedule)) throw Object.assign(new Error('Closure worker schedule conflict'), {
            status: 409, code: 'CLOSURE_WORKER_SCHEDULE_CONFLICT'
          });
          counts.failed += 1;
          if (needsAttention(code)) counts.needsAttention += 1;
          continue;
        }
        const current = await jobs.findOne({ _id: candidate._id, owner: candidate.owner }, {
          projection: { _id: 1, owner: 1, status: 1 }
        });
        if (!current) throw Object.assign(new Error('Closure job unavailable'), {
          code: 'CLOSURE_JOB_UNAVAILABLE'
        });
        if (!INCOMPLETE_STATUSES.includes(current.status) && current.status !== 'complete') {
          throw Object.assign(new Error('Closure stage unavailable'), {
            status: 503, code: 'CLOSURE_WORKER_STAGE_UNAVAILABLE'
          });
        }
        if (current.status === 'complete') {
          const schedule = await jobs.updateOne({ _id: candidate._id, owner: candidate.owner, status: 'complete' }, {
            $set: { lastAttemptAt: attemptedAt },
            $unset: { nextAttemptAt: '', lastErrorCode: '', needsAttention: '' }
          });
          if (!changed(schedule)) throw Object.assign(new Error('Closure worker schedule conflict'), {
            status: 409, code: 'CLOSURE_WORKER_SCHEDULE_CONFLICT'
          });
          counts.completed += 1;
        } else {
          const schedule = await jobs.updateOne({ _id: candidate._id, owner: candidate.owner,
            status: { $in: INCOMPLETE_STATUSES } }, {
            $set: { nextAttemptAt: attemptedAt + retryMs, lastAttemptAt: attemptedAt },
            $unset: { lastErrorCode: '', needsAttention: '' }
          });
          if (!changed(schedule)) throw Object.assign(new Error('Closure worker schedule conflict'), {
            status: 409, code: 'CLOSURE_WORKER_SCHEDULE_CONFLICT'
          });
          counts.deferred += 1;
        }
      }
      return counts;
    } finally {
      running = false;
    }
  }

  return { runBatch };
}

module.exports = { createCareClosureWorker, INCOMPLETE_STATUSES };

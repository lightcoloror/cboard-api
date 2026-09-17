'use strict';
const { expect } = require('chai');
const { inspectCareClosureJob } = require('../../api/helpers/careClosureDiagnostics');

function fixture(job) {
  const reads = [];
  return { reads, connection: { collection(name) {
    expect(name).to.equal('careclosurejobs');
    return { async findOne(filter, options) { reads.push({ filter, options }); return job; } };
  } } };
}
describe('read-only closure diagnostics', function() {
  it('uses a strict projection and outputs no owner, receipt, content or raw claim', async function() {
    const h = fixture({ status: 'media_cleanup', owner: 'private-owner', sealed: 'patient-content',
      secret: 'receipt-secret', cleanupClaim: 'private-claim', lastErrorCode: 'CLOSURE_CLEANUP_IN_PROGRESS' });
    const result = await inspectCareClosureJob({ connection: h.connection, operationId: 'job', now: () => 100 });
    expect(result.nextAction).to.equal('operator_review');
    expect(result.automaticClaimReleaseAllowed).to.equal(false);
    expect(result.cleanupClaimPresent).to.equal(true);
    const text = JSON.stringify(result);
    for (const secret of ['private-owner', 'patient-content', 'receipt-secret', 'private-claim']) expect(text).not.to.include(secret);
    expect(h.reads[0].options.projection).to.deep.equal({ _id: 0, status: 1, updatedAt: 1,
      nextAttemptAt: 1, lastAttemptAt: 1, lastErrorCode: 1, needsAttention: 1, cleanupClaim: 1 });
  });
  it('distinguishes a scheduled wait, due retry and completed job without writing', async function() {
    for (const [job, action, deleted] of [
      [{ status: 'prepared', nextAttemptAt: 101 }, 'wait_for_scheduled_attempt', false],
      [{ status: 'prepared', nextAttemptAt: 100 }, 'run_existing_worker', false],
      [{ status: 'complete' }, 'none', true]
    ]) {
      const h = fixture(job);
      const result = await inspectCareClosureJob({ connection: h.connection, operationId: 'job', now: () => 100 });
      expect(result.nextAction).to.equal(action); expect(result.accountDeleted).to.equal(deleted);
      expect(h.reads).to.have.length(1);
    }
  });
  it('does not treat unknown, malformed or contradictory states as a safe retry', async function() {
    for (const job of [{ status: 'secret-state' }, { status: 'prepared', nextAttemptAt: 'tomorrow' },
      { status: 'complete', cleanupClaim: '' }, { status: 'media_cleanup', needsAttention: true },
      { status: 'prepared', lastErrorCode: 'CLOSURE_UPLOAD_PENDING' },
      { status: 'complete', lastErrorCode: 'CLOSURE_USER_REAPPEARED' },
      { status: 'prepared', needsAttention: 'true' }]) {
      const result = await inspectCareClosureJob({ connection: fixture(job).connection, operationId: 'job' });
      expect(result.nextAction).to.equal('operator_review'); expect(result.accountDeleted).to.equal(false);
    }
  });
  it('rejects invalid operation identifiers before accessing the database', async function() {
    const h = fixture(null);
    for (const operationId of ['', '__proto__', { $ne: null }, 'a'.repeat(81)]) {
      try { await inspectCareClosureJob({ connection: h.connection, operationId }); throw new Error('expected rejection'); }
      catch (error) { expect(error.code).to.equal('INVALID_CLOSURE_JOB'); }
    }
    expect(h.reads).to.have.length(0);
  });
  it('reports missing jobs and sanitizes non-code errors and invalid timestamps', async function() {
    try { await inspectCareClosureJob({ connection: fixture(null).connection, operationId: 'job' }); throw new Error('expected rejection'); }
    catch (error) { expect(error.code).to.equal('CLOSURE_JOB_UNAVAILABLE'); }
    const result = await inspectCareClosureJob({ connection: fixture({ status: 'prepared', lastErrorCode: 'mongodb://secret', updatedAt: -1 }).connection, operationId: 'job' });
    expect(result.lastErrorCode).to.equal(null); expect(result.updatedAt).to.equal(null);
    expect(result.nextAction).to.equal('operator_review');
  });
});

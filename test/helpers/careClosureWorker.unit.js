'use strict';

const chai = require('chai');
const { createCareClosureWorker, INCOMPLETE_STATUSES } = require('../../api/helpers/careClosureWorker');

const expect = chai.expect;

function matches(row, filter) {
  return Object.keys(filter).every(key => {
    const expected = filter[key];
    if (key === '$or') return expected.some(item => matches(row, item));
    if (expected && expected.$in) return expected.$in.includes(row[key]);
    if (expected && expected.$exists !== undefined) return (row[key] !== undefined) === expected.$exists;
    if (expected && expected.$lte !== undefined) return row[key] <= expected.$lte;
    return row[key] === expected;
  });
}

function createConnection(seed, options = {}) {
  const rows = seed.map(row => ({ ...row }));
  const updates = [];
  const reads = [];
  const jobs = {
    find(filter, options) {
      reads.push({ method: 'find', filter, options });
      let values = rows.filter(row => matches(row, filter));
      return {
        sort(sortSpec) {
          values = values.slice().sort((left, right) => {
            for (const key of Object.keys(sortSpec)) {
              const delta = String(left[key] || '').localeCompare(String(right[key] || ''));
              if (delta) return sortSpec[key] < 0 ? -delta : delta;
            }
            return 0;
          });
          return this;
        },
        limit(limit) {
          values = values.slice(0, limit);
          return this;
        },
        async toArray() { return values; }
      };
    },
    async findOne(filter, options) {
      reads.push({ method: 'findOne', filter, options });
      return rows.find(row => matches(row, filter)) || null;
    },
    async updateOne(filter, change) {
      updates.push({ filter, change });
      if (options.updateError) throw options.updateError;
      const row = rows.find(item => matches(item, filter));
      if (!row) return { matchedCount: 0 };
      Object.assign(row, change.$set || {});
      for (const field of Object.keys(change.$unset || {})) delete row[field];
      return { matchedCount: 1 };
    }
  };
  return {
    connection: { collection(name) { expect(name).to.equal('careclosurejobs'); return jobs; } },
    rows,
    updates,
    reads
  };
}

async function expectCode(promise, code) {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error.code).to.equal(code);
  }
}

describe('care closure worker', function() {
  it('scans known due stages in deterministic order and respects maxJobs', async function() {
    const fixture = createConnection([
      { _id: 'b', owner: 'owner-b', status: 'prepared' },
      { _id: 'future', owner: 'owner-future', status: 'prepared', nextAttemptAt: 2000 },
      { _id: 'a', owner: 'owner-a', status: 'media_cleanup' },
      { _id: 'done', owner: 'owner-done', status: 'complete' },
      { _id: 'unknown', owner: 'owner-unknown', status: 'mystery' }
    ]);
    const calls = [];
    const worker = createCareClosureWorker({
      connection: fixture.connection,
      runner: { async run(owner, operationId) { calls.push([owner, operationId]); } },
      now: () => 1000,
      maxJobs: 2,
      retryMs: 50
    });

    const result = await worker.runBatch();

    expect(result).to.deep.equal({ scanned: 2, attempted: 2, completed: 0, deferred: 2, failed: 0, needsAttention: 0 });
    expect(calls).to.deep.equal([['owner-a', 'a'], ['owner-b', 'b']]);
    expect(fixture.rows.find(row => row._id === 'a').nextAttemptAt).to.equal(1050);
    expect(fixture.rows.find(row => row._id === 'done').nextAttemptAt).to.equal(undefined);
    expect(INCOMPLETE_STATUSES).to.not.include('complete');
  });

  it('records only a stable error code and marks attention without changing closure fields', async function() {
    const fixture = createConnection([{ _id: 'job-1', owner: 'owner-1', status: 'access_revoked', rev: 8, cleanupClaim: 'claim' }]);
    const worker = createCareClosureWorker({
      connection: fixture.connection,
      runner: { async run() { throw Object.assign(new Error('secret owner@example.test'), { code: 'CLOSURE_RECONCILIATION_REQUIRED' }); } },
      now: () => 100,
      retryMs: 10
    });

    const result = await worker.runBatch();
    const row = fixture.rows[0];

    expect(result).to.deep.equal({ scanned: 1, attempted: 1, completed: 0, deferred: 0, failed: 1, needsAttention: 1 });
    expect(row.status).to.equal('access_revoked');
    expect(row.rev).to.equal(8);
    expect(row.cleanupClaim).to.equal('claim');
    expect(row.lastErrorCode).to.equal('CLOSURE_RECONCILIATION_REQUIRED');
    expect(row.message).to.equal(undefined);
    expect(row.stack).to.equal(undefined);
  });

  it('uses fallback error code for untrusted errors and does not clear claim', async function() {
    const fixture = createConnection([{ _id: 'job-2', owner: 'owner-2', status: 'account_cleanup_pending', cleanupClaim: 'claim-2' }]);
    const worker = createCareClosureWorker({
      connection: fixture.connection,
      runner: { async run() { throw new Error('provider secret'); } },
      now: () => 400
    });

    await worker.runBatch();

    expect(fixture.rows[0].lastErrorCode).to.equal('CLOSURE_WORKER_FAILED');
    expect(fixture.rows[0].needsAttention).to.equal(false);
    expect(fixture.rows[0].cleanupClaim).to.equal('claim-2');
  });

  it('clears scheduling error fields only after persisted completion', async function() {
    const fixture = createConnection([{ _id: 'job-3', owner: 'owner-3', status: 'access_revoked', nextAttemptAt: 1, lastErrorCode: 'OLD', needsAttention: true }]);
    const worker = createCareClosureWorker({
      connection: fixture.connection,
      runner: { async run() { fixture.rows[0].status = 'complete'; } },
      now: () => 500
    });

    const result = await worker.runBatch();

    expect(result.completed).to.equal(1);
    expect(fixture.rows[0].status).to.equal('complete');
    expect(fixture.rows[0].lastErrorCode).to.equal(undefined);
    expect(fixture.rows[0].needsAttention).to.equal(undefined);
    expect(fixture.rows[0].nextAttemptAt).to.equal(undefined);
  });

  it('skips future retries and rejects a concurrent batch without touching jobs', async function() {
    const fixture = createConnection([
      { _id: 'due', owner: 'owner-due', status: 'prepared' },
      { _id: 'future', owner: 'owner-future', status: 'prepared', nextAttemptAt: 2000 }
    ]);
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const worker = createCareClosureWorker({
      connection: fixture.connection,
      runner: { async run() { await blocked; } },
      now: () => 1000
    });
    const first = worker.runBatch();
    await expectCode(worker.runBatch(), 'CLOSURE_WORKER_BUSY');
    release();
    const result = await first;

    expect(result).to.deep.equal({ scanned: 1, attempted: 1, completed: 0, deferred: 1, failed: 0, needsAttention: 0 });
    expect(fixture.rows.find(row => row._id === 'future').nextAttemptAt).to.equal(2000);
  });

  it('propagates scan failures without converting them to job metadata', async function() {
    const scanError = new Error('scan failed');
    const connection = { collection() { return { find() { throw scanError; } }; } };
    const worker = createCareClosureWorker({ connection, runner: { run: async () => {} } });
    let caught;
    try { await worker.runBatch(); } catch (error) { caught = error; }
    expect(caught).to.equal(scanError);
  });

  it('propagates scheduling write failures', async function() {
    const updateError = new Error('schedule write failed');
    const fixture = createConnection([{ _id: 'job-write', owner: 'owner-write', status: 'prepared' }], { updateError });
    const worker = createCareClosureWorker({
      connection: fixture.connection,
      runner: { run: async () => {} }
    });
    let caught;
    try { await worker.runBatch(); } catch (error) { caught = error; }
    expect(caught).to.equal(updateError);
  });

  it('fails closed when a runner leaves an unknown persisted stage', async function() {
    const fixture = createConnection([{ _id: 'job-stage', owner: 'owner-stage', status: 'prepared' }]);
    const worker = createCareClosureWorker({
      connection: fixture.connection,
      runner: { async run() { fixture.rows[0].status = 'unexpected'; } }
    });
    await expectCode(worker.runBatch(), 'CLOSURE_WORKER_STAGE_UNAVAILABLE');
    expect(fixture.updates).to.deep.equal([]);
  });
});

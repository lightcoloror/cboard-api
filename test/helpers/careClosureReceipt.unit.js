'use strict';

const crypto = require('crypto');
const chai = require('chai');
const {
  createCareClosureReceipt,
  INTENT_MS,
  STATUS_MS
} = require('../../api/helpers/careClosureReceipt');

const expect = chai.expect;
const OWNER = '0123456789abcdef01234567';
const OPERATION = 'closure-operation-1';

function collection(docs, calls) {
  return {
    async updateOne(filter, update, options) {
      calls.updateOne.push({ filter, update, options });
      let doc = docs.find(item => String(item._id) === String(filter._id));
      if (!doc && options && options.upsert) {
        doc = { _id: filter._id };
        docs.push(doc);
      }
      if (!doc) return { matchedCount: 0 };
      if (filter.status && doc.status !== filter.status) return { matchedCount: 0 };
      if (filter.secretHash && doc.secretHash !== filter.secretHash) return { matchedCount: 0 };
      if (filter.expiresAt && filter.expiresAt.$gt !== undefined && !(doc.expiresAt > filter.expiresAt.$gt)) {
        return { matchedCount: 0 };
      }
      if (update.$set) Object.assign(doc, update.$set);
      if (update.$unset) Object.keys(update.$unset).forEach(key => delete doc[key]);
      return { matchedCount: 1 };
    },
    async findOne(filter, options) {
      calls.findOne.push({ filter, options });
      const doc = docs.find(item => String(item._id) === String(filter._id) &&
        (!filter.secretHash || item.secretHash === filter.secretHash) &&
        (!filter.owner || item.owner === filter.owner) &&
        (!filter.status || item.status === filter.status) &&
        (!filter.expiresAt || item.expiresAt > filter.expiresAt.$gt));
      return doc || null;
    }
  };
}

function factory({ now = 1000, receipts = [], jobs = [] } = {}) {
  const calls = { updateOne: [], findOne: [] };
  const jobCalls = { findOne: [] };
  const session = { id: 'receipt-session' };
  const connection = {
    collection(name) {
      if (name === 'careclosurereceipts') return collection(receipts, calls);
      if (name === 'careclosurejobs') {
        return {
          async findOne(filter, options) {
            jobCalls.findOne.push({ filter, options });
            return jobs.find(job => job._id === filter._id && job.owner === filter.owner) || null;
          }
        };
      }
      throw new Error(`unexpected collection ${name}`);
    }
  };
  const lifecycleCalls = [];
  const lifecycle = {
    async withOpenAccount(owner, callback) {
      lifecycleCalls.push(owner);
      return callback(session);
    }
  };
  const receipt = createCareClosureReceipt({ connection, lifecycle, now: () => now });
  return { receipt, receipts, jobs, calls, jobCalls, session, lifecycleCalls, setNow(value) { now = value; } };
}

async function expectCode(promise, code, status) {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error.code).to.equal(code);
    if (status !== undefined) expect(error.status).to.equal(status);
  }
}

async function expectTypeError(promise, message) {
  let error;
  try { await promise; } catch (caught) { error = caught; }
  expect(error).to.be.instanceOf(TypeError);
  expect(error.message).to.include(message);
}

describe('care closure receipt capability', function() {
  it('generates a random 64-hex secret and stores only its hash', async function() {
    const f = factory();
    const result = await f.receipt.prepare(OWNER);

    expect(result).to.include({ receiptId: OWNER, expiresAt: 1000 + INTENT_MS });
    expect(result.secret).to.match(/^[a-f0-9]{64}$/);
    expect(f.receipts[0]).not.to.have.property('secret');
    expect(f.receipts[0].secretHash).to.equal(
      crypto.createHash('sha256').update(result.secret).digest('hex')
    );
    expect(f.calls.updateOne[0].filter).to.deep.equal({ _id: OWNER });
    expect(f.calls.updateOne[0].options.session).to.equal(f.session);
  });

  it('invalidates the previous secret when preparing again', async function() {
    const f = factory();
    const first = await f.receipt.prepare(OWNER);
    const second = await f.receipt.prepare(OWNER);

    await expectCode(f.receipt.inspect(OWNER, first.secret), 'CLOSURE_RECEIPT_UNAVAILABLE', 404);
    expect((await f.receipt.inspect(OWNER, second.secret)).status).to.equal('prepared');
  });

  it('uses strict greater-than expiry boundaries for inspect and bind', async function() {
    const f = factory();
    const prepared = await f.receipt.prepare(OWNER);
    f.setNow(prepared.expiresAt);

    await expectCode(f.receipt.inspect(OWNER, prepared.secret), 'CLOSURE_RECEIPT_UNAVAILABLE', 404);
    await expectCode(f.receipt.bind(OWNER, prepared.secret, OPERATION, f.session), 'CLOSURE_RECEIPT_UNAVAILABLE', 404);
  });

  it('requires a transaction session and binds only a live prepared receipt', async function() {
    const f = factory();
    const prepared = await f.receipt.prepare(OWNER);
    await expectTypeError(
      f.receipt.bind(OWNER, prepared.secret, OPERATION),
      'transaction'
    );
  });

  it('returns one generic 404 for malformed, unknown, and wrong secrets', async function() {
    const f = factory();
    const prepared = await f.receipt.prepare(OWNER);
    await expectCode(f.receipt.inspect(OWNER, 'bad-secret'), 'CLOSURE_RECEIPT_UNAVAILABLE', 404);
    await expectCode(f.receipt.inspect('not-an-owner', prepared.secret), 'CLOSURE_RECEIPT_UNAVAILABLE', 404);
    await expectCode(f.receipt.bind(OWNER, 'bad-secret', OPERATION, f.session), 'CLOSURE_RECEIPT_UNAVAILABLE', 404);
  });

  it('exposes only redacted prepared and confirmed status', async function() {
    const f = factory({ jobs: [{ _id: OPERATION, owner: OWNER, status: 'complete', updatedAt: 55, sealed: 'manifest-secret' }] });
    const prepared = await f.receipt.prepare(OWNER);
    const preparedStatus = await f.receipt.inspect(OWNER, prepared.secret);
    expect(preparedStatus).to.deep.equal({ status: 'prepared', accountDeleted: false, expiresAt: prepared.expiresAt });
    expect(preparedStatus).not.to.have.any.keys('owner', 'email', 'manifest', 'secret');

    await f.receipt.bind(OWNER, prepared.secret, OPERATION, f.session);
    const confirmed = await f.receipt.inspect(OWNER, prepared.secret);
    expect(confirmed).to.deep.equal({ status: 'confirmed', operationId: OPERATION,
      cleanupStatus: 'complete', accountDeleted: true, updatedAt: 55,
      expiresAt: 1000 + STATUS_MS });
    expect(confirmed).not.to.have.any.keys('owner', 'email', 'manifest', 'secret');
    expect(f.jobCalls.findOne[0].filter).to.deep.equal({ _id: OPERATION, owner: OWNER });
    expect(f.jobCalls.findOne[0].options.projection).to.deep.equal({ _id: 1, status: 1, updatedAt: 1 });
  });

  it('does not bind a confirmed receipt a second time', async function() {
    const f = factory();
    const prepared = await f.receipt.prepare(OWNER);
    await f.receipt.bind(OWNER, prepared.secret, OPERATION, f.session);
    await expectCode(f.receipt.bind(OWNER, prepared.secret, 'second-operation', f.session), 'CLOSURE_RECEIPT_UNAVAILABLE', 404);
  });

  it('reports a missing confirmed job as unavailable without leaking receipt data', async function() {
    const f = factory();
    const prepared = await f.receipt.prepare(OWNER);
    await f.receipt.bind(OWNER, prepared.secret, OPERATION, f.session);
    await expectCode(f.receipt.inspect(OWNER, prepared.secret), 'CLOSURE_JOB_UNAVAILABLE', 503);
  });
});

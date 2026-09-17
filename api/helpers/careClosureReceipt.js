'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { createCareFamilyLifecycle } = require('./careFamilyLifecycle');
const { fail } = require('./carePolicy');
const validOwner = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
const validSecret = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const INTENT_MS = 15 * 60 * 1000;
const STATUS_MS = 30 * 24 * 60 * 60 * 1000;

// Internal capability adapter. A receipt can only read bounded task status;
// it never authorizes confirmation, cleanup, login, or patient data access.
function createCareClosureReceipt({ connection = mongoose.connection, lifecycle = null, now = Date.now } = {}) {
  const receipts = connection.collection('careclosurereceipts');
  const jobs = connection.collection('careclosurejobs');
  const gate = lifecycle || createCareFamilyLifecycle({ connection });
  function credentials(owner, secret) {
    if (!validOwner(owner) || !validSecret(secret)) fail(404, 'CLOSURE_RECEIPT_UNAVAILABLE');
    return { _id: owner, secretHash: hash(secret) };
  }
  return {
    async prepare(owner) {
      if (!validOwner(owner)) fail(400, 'INVALID_OWNER');
      const secret = crypto.randomBytes(32).toString('hex');
      const expiresAt = now() + INTENT_MS;
      await gate.withOpenAccount(owner, session => receipts.updateOne({ _id: owner }, {
        $set: { secretHash: hash(secret), status: 'prepared', expiresAt, createdAt: now() },
        $unset: { operationId: '', confirmedAt: '' }
      }, { upsert: true, session }));
      // The client must persist this response before sending confirmation.
      // Preparing again deliberately invalidates any previous unused receipt.
      return { receiptId: owner, secret, expiresAt };
    },
    async bind(owner, secret, operationId, session) {
      if (!session) throw new TypeError('Closure receipt binding requires transaction');
      const filter = credentials(owner, secret);
      if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(operationId)) fail(400, 'INVALID_CLOSURE_JOB');
      const at = now();
      const result = await receipts.updateOne({ ...filter, status: 'prepared', expiresAt: { $gt: at } }, {
        $set: { status: 'confirmed', operationId, confirmedAt: at, expiresAt: at + STATUS_MS }
      }, { session });
      if (Number(result.matchedCount === undefined ? result.n : result.matchedCount) !== 1) fail(404, 'CLOSURE_RECEIPT_UNAVAILABLE');
    },
    async inspect(receiptId, secret) {
      const receipt = await receipts.findOne({ ...credentials(receiptId, secret), expiresAt: { $gt: now() } });
      if (!receipt) fail(404, 'CLOSURE_RECEIPT_UNAVAILABLE');
      if (receipt.status === 'prepared') return { status: 'prepared', accountDeleted: false, expiresAt: receipt.expiresAt };
      if (receipt.status !== 'confirmed') fail(404, 'CLOSURE_RECEIPT_UNAVAILABLE');
      const job = await jobs.findOne({ _id: receipt.operationId, owner: receiptId },
        { projection: { _id: 1, status: 1, updatedAt: 1 } });
      if (!job) fail(503, 'CLOSURE_JOB_UNAVAILABLE');
      return { status: 'confirmed', operationId: job._id, cleanupStatus: job.status,
        accountDeleted: job.status === 'complete', updatedAt: job.updatedAt, expiresAt: receipt.expiresAt };
    }
  };
}
module.exports = { createCareClosureReceipt, INTENT_MS, STATUS_MS };

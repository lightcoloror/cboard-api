'use strict';

const chai = require('chai');
const { createCareClosureFinalize } = require('../../api/helpers/careClosureFinalize');

const expect = chai.expect;
const OWNER = '0123456789abcdef01234567';

function collection(docs = []) {
  const calls = { findOne: [], updateOne: [], deleteOne: [] };
  return {
    calls,
    async findOne(filter) {
      calls.findOne.push(filter);
      return docs.find(doc => String(doc._id) === String(filter._id) && (!filter.owner || doc.owner === filter.owner)) || null;
    },
    async updateOne(filter, update) {
      calls.updateOne.push({ filter, update });
      const doc = docs.find(item => String(item._id) === String(filter._id));
      if (!doc || (filter.rev !== undefined && filter.rev !== doc.rev) ||
        (filter.cleanupClaim && filter.cleanupClaim.$exists === false && doc.cleanupClaim !== undefined)) return { matchedCount: 0 };
      if (update.$set) Object.assign(doc, update.$set);
      if (update.$unset) Object.keys(update.$unset).forEach(key => { delete doc[key]; });
      if (update.$inc) Object.keys(update.$inc).forEach(key => { doc[key] = (doc[key] || 0) + update.$inc[key]; });
      return { matchedCount: 1 };
    },
    async deleteOne(filter) {
      calls.deleteOne.push(filter);
      const index = docs.findIndex(doc => String(doc._id) === String(filter._id) && (!filter.email || doc.email === filter.email));
      if (index < 0) return { deletedCount: 0 };
      docs.splice(index, 1);
      return { deletedCount: 1 };
    }
  };
}

function factory({ jobStatus = 'access_revoked', jobExtra = {}, lifecycle, user = { _id: OWNER, email: 'owner@example.test' }, account, family, profile, funding, cleanup = async () => {}, revokeSessions = async () => {} } = {}) {
  const operationId = 'op-1';
  const job = { _id: operationId, owner: OWNER, status: jobStatus, rev: 0, ...jobExtra };
  const jobs = collection([job]);
  const lifecycles = collection([lifecycle || { _id: OWNER, status: 'closing', closure: { status: 'closing', owner: OWNER, operationId } }]);
  const users = collection(user ? [user] : []);
  const accounts = collection(account ? [account] : []);
  const families = collection(family ? [family] : []);
  const profiles = collection(profile ? [profile] : []);
  const fundings = collection(funding ? [funding] : []);
  const state = { ended: 0 };
  const session = { async withTransaction(callback) { await callback(session); }, async endSession() { state.ended += 1; } };
  const connection = { async startSession() { return session; }, collection(name) {
    return { careclosurejobs: jobs, careaccountlifecycles: lifecycles, users, careaccounts: accounts,
      carefamilies: families, careprofiles: profiles, carefundings: fundings }[name];
  } };
  const encryption = { open(value) { return value.state || value; }, seal(value) { return { state: value }; } };
  const finalize = createCareClosureFinalize({ connection, encryption, cleanup, revokeSessions, now: () => 1700000000000 });
  return { finalize, jobs, lifecycles, users, accounts, state, job, operationId };
}

async function expectCode(promise, code) {
  try { await promise; throw new Error(`expected ${code}`); } catch (error) { expect(error.code).to.equal(code); }
}

describe('care closure finalize', function() {
  it('requires both cleanup adapters at construction', function() {
    expect(() => createCareClosureFinalize({ cleanup: async () => {} })).to.throw(TypeError, 'Account cleanup adapters required');
    expect(() => createCareClosureFinalize({ revokeSessions: async () => {} })).to.throw(TypeError, 'Account cleanup adapters required');
  });

  it('requires the actual 24-hex owner id before invoking adapters', async function() {
    const calls = { cleanup: 0, revoke: 0 };
    const f = factory({ cleanup: async () => { calls.cleanup += 1; }, revokeSessions: async () => { calls.revoke += 1; } });
    await expectCode(f.finalize.run('owner-1', 'op-1'), 'INVALID_CLOSURE_JOB');
    expect(calls).to.deep.equal({ cleanup: 0, revoke: 0 });
  });

  it('rejects scope mismatch without invoking cleanup or revocation', async function() {
    const calls = { cleanup: 0, revoke: 0 };
    const f = factory({ lifecycle: { _id: OWNER, status: 'closing', closure: { status: 'closing', owner: OWNER, operationId: 'other-op' } }, cleanup: async () => { calls.cleanup += 1; }, revokeSessions: async () => { calls.revoke += 1; } });
    await expectCode(f.finalize.run(OWNER, 'op-1'), 'CLOSURE_SCOPE_MISMATCH');
    expect(calls).to.deep.equal({ cleanup: 0, revoke: 0 });
  });

  it('retains User and cleanupClaim when an adapter fails', async function() {
    const f = factory({ cleanup: async () => { throw Object.assign(new Error('cleanup failed'), { code: 'LEGACY_CLEANUP_FAILED' }); } });
    await expectCode(f.finalize.run(OWNER, 'op-1'), 'LEGACY_CLEANUP_FAILED');
    expect(f.users.calls.deleteOne).to.have.length(0);
    expect(f.job.cleanupClaim).to.be.a('string');
    expect(f.job.status).to.equal('account_cleanup_pending');
    expect(f.state.ended).to.equal(1);
  });

  it('rejects a second claimant without invoking adapters or taking over', async function() {
    const calls = { cleanup: 0, revoke: 0 };
    const f = factory({ jobExtra: { cleanupClaim: 'existing-claim', status: 'account_cleanup_pending', accountCleanup: { state: { email: 'owner@example.test' } } }, cleanup: async () => { calls.cleanup += 1; }, revokeSessions: async () => { calls.revoke += 1; } });
    await expectCode(f.finalize.run(OWNER, 'op-1'), 'CLOSURE_CLEANUP_IN_PROGRESS');
    expect(calls).to.deep.equal({ cleanup: 0, revoke: 0 });
    expect(f.users.calls.deleteOne).to.have.length(0);
  });

  it('deletes User and closes lifecycle/job only after both adapters complete', async function() {
    const calls = { cleanup: 0, revoke: 0 };
    const f = factory({ cleanup: async args => { calls.cleanup += 1; expect(args).to.deep.equal({ id: OWNER, userEmail: 'owner@example.test' }); }, revokeSessions: async id => { calls.revoke += 1; expect(id).to.equal(OWNER); } });
    const result = await f.finalize.run(OWNER, 'op-1');
    expect(result).to.deep.equal({ status: 'complete', accountDeleted: true });
    expect(calls).to.deep.equal({ cleanup: 1, revoke: 1 });
    expect(f.users.calls.deleteOne).to.have.length(1);
    expect(f.users.calls.deleteOne[0].email).to.equal('owner@example.test');
    expect(f.lifecycles.calls.updateOne[0].update.$set.status).to.equal('closed');
    expect(f.job.status).to.equal('complete');
    expect(f.job.cleanupClaim).to.equal(undefined);
    expect(f.job.sealed).to.equal(undefined);
    expect(f.state.ended).to.equal(2);
  });
});

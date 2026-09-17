'use strict';

const chai = require('chai');
const { createCareClosureDataStep } = require('../../api/helpers/careClosureDataStep');

const expect = chai.expect;

function chain(values) {
  return {
    project() { return this; },
    limit() { return this; },
    async toArray() { return values; }
  };
}

function collection({ docs = [], findValues = docs } = {}) {
  const calls = { findOne: [], find: [], deleteMany: [], replaceOne: [], updateOne: [] };
  return {
    calls,
    async findOne(filter) {
      calls.findOne.push(filter);
      return docs.find(doc => doc._id === filter._id && (!filter.owner || doc.owner === filter.owner)) || null;
    },
    find(filter) {
      calls.find.push(filter);
      return chain(typeof findValues === 'function' ? findValues(filter) : findValues);
    },
    async deleteMany(filter) { calls.deleteMany.push(filter); return { acknowledged: true, deletedCount: 1 }; },
    async replaceOne(filter, replacement) { calls.replaceOne.push({ filter, replacement }); return { matchedCount: 1 }; },
    async updateOne(filter, update) { calls.updateOne.push({ filter, update }); return { matchedCount: 1 }; }
  };
}

function factory({ jobStatus = 'accounts_cleaned', fundingState = { receipts: { receipt: { status: 'settled' } } }, lifecycle, account, profile, family, funding } = {}) {
  const operationId = 'op-1';
  const plan = {
    version: 1, owner: 'owner-1', familyIds: ['family-1'], profileIds: ['profile-1'],
    familyFundingIds: ['fund-1'], relatedAccountIds: ['owner-1'], media: [], pendingUsage: [], institutionAdminIds: []
  };
  const job = { _id: operationId, owner: 'owner-1', status: jobStatus, rev: 4, mediaCursor: 0, accountCursor: 1, sealed: { plan } };
  const jobs = collection({ docs: [job] });
  const lifecycles = collection({ docs: [lifecycle || { _id: 'owner-1', status: 'closing', closure: { status: 'closing', owner: 'owner-1', operationId, familyIds: ['family-1'] } }] });
  const familyDoc = family || { _id: 'family-1', owner: 'owner-1', closure: { status: 'closing', owner: 'owner-1', operationId, at: 1 }, sealed: { state: {} } };
  const families = collection({ docs: [familyDoc], findValues: [familyDoc] });
  const profileDoc = profile || { _id: 'profile-1', familyId: 'family-1' };
  const profiles = collection({ docs: [profileDoc], findValues: [profileDoc] });
  const fundingDoc = funding || { _id: 'fund-1', kind: 'family', familyId: 'family-1', sealed: { state: fundingState } };
  const fundings = collection({ docs: [fundingDoc], findValues: [fundingDoc] });
  const accounts = collection({ docs: account ? [account] : [] });
  const communicators = collection();
  const state = { ended: false };
  const session = { async withTransaction(callback) { await callback(session); }, async endSession() { state.ended = true; } };
  const connection = { async startSession() { return session; }, collection(name) {
    return { careclosurejobs: jobs, careaccountlifecycles: lifecycles, carefamilies: families,
      careprofiles: profiles, carefundings: fundings, careaccounts: accounts, communicators }[name];
  } };
  const encryption = { open(value) { return value.plan || value.state || value; }, seal(value) { return { state: value }; } };
  const step = createCareClosureDataStep({ connection, encryption, now: () => 1700000000000 });
  return { step, jobs, lifecycles, families, profiles, fundings, accounts, communicators, state, job };
}

async function expectCode(promise, code) {
  try { await promise; throw new Error(`expected ${code}`); } catch (error) { expect(error.code).to.equal(code); }
}

describe('care closure data step', function() {
  it('rejects before writes when accounts are not complete', async function() {
    const f = factory({ jobStatus: 'account_cleanup' });
    await expectCode(f.step.run('owner-1', 'op-1'), 'CLOSURE_ACCOUNTS_NOT_COMPLETE');
    expect(f.communicators.calls.deleteMany).to.have.length(0);
    expect(f.profiles.calls.deleteMany).to.have.length(0);
  });

  it('rejects a mismatched closure scope before deletion', async function() {
    const f = factory({ lifecycle: { _id: 'owner-1', status: 'closing', closure: { status: 'closing', owner: 'owner-1', operationId: 'other-op', familyIds: ['family-1'] } } });
    await expectCode(f.step.run('owner-1', 'op-1'), 'CLOSURE_SCOPE_MISMATCH');
    expect(f.communicators.calls.deleteMany).to.have.length(0);
  });

  it('rejects reserved family funding before deleting any data', async function() {
    const f = factory({ fundingState: { receipts: { receipt: { status: 'reserved' } } } });
    await expectCode(f.step.run('owner-1', 'op-1'), 'CLOSURE_RECONCILIATION_REQUIRED');
    expect(f.communicators.calls.deleteMany).to.have.length(0);
    expect(f.fundings.calls.deleteMany).to.have.length(0);
  });

  it('deletes only double-marked communicators and family funding, then closes family data', async function() {
    const f = factory();
    const result = await f.step.run('owner-1', 'op-1');
    expect(result).to.deep.equal({ status: 'family_data_cleaned', count: 1 });
    expect(f.communicators.calls.deleteMany).to.deep.equal([{ careFamilyId: 'family-1', careProfileId: 'profile-1' }]);
    expect(f.profiles.calls.deleteMany[0]).to.deep.equal({ _id: { $in: ['profile-1'] }, familyId: { $in: ['family-1'] } });
    expect(f.fundings.calls.deleteMany[0]).to.deep.equal({ _id: { $in: ['fund-1'] }, kind: 'family', familyId: { $in: ['family-1'] } });
    expect(f.accounts.calls.updateOne).to.have.length(0);
    expect(f.job.status).to.equal('accounts_cleaned');
    expect(f.state.ended).to.equal(true);
  });

  it('always ends the transaction session when validation fails', async function() {
    const f = factory({ family: { _id: 'family-1', owner: 'other-owner', closure: { status: 'closing', owner: 'other-owner', operationId: 'op-1' }, sealed: { state: {} } } });
    await expectCode(f.step.run('owner-1', 'op-1'), 'CLOSURE_SCOPE_MISMATCH');
    expect(f.state.ended).to.equal(true);
  });
});

'use strict';

const chai = require('chai');
const { createCareClosureAccessStep } = require('../../api/helpers/careClosureAccessStep');

const expect = chai.expect;

function collection(docs = []) {
  const calls = { findOne: [], updateOne: [] };
  return {
    calls,
    async findOne(filter) {
      calls.findOne.push(filter);
      if (filter.members) return docs.find(doc => Array.isArray(doc.members) && doc.members.includes(filter.members)) || null;
      return docs.find(doc => doc._id === filter._id && (!filter.owner || doc.owner === filter.owner)) || null;
    },
    async updateOne(filter, update) {
      calls.updateOne.push({ filter, update });
      const doc = docs.find(item => item._id === filter._id);
      if (doc && filter.rev === doc.rev) {
        if (update.$set) Object.assign(doc, update.$set);
        if (update.$inc) Object.keys(update.$inc).forEach(key => { doc[key] = (doc[key] || 0) + update.$inc[key]; });
        return { matchedCount: 1 };
      }
      return { matchedCount: 0 };
    }
  };
}

function factory({ jobStatus = 'family_data_cleaned', profile, funding, lifecycle } = {}) {
  const operationId = 'op-1';
  const job = { _id: operationId, owner: 'owner-1', status: jobStatus, rev: 0 };
  const jobs = collection([job]);
  const lifecycles = collection([lifecycle || { _id: 'owner-1', status: 'closing', closure: { status: 'closing', owner: 'owner-1', operationId } }]);
  const profiles = collection(profile ? [profile] : []);
  const families = collection([{ _id: 'family-1', owner: 'family-owner' }]);
  const fundings = collection(funding ? [funding] : []);
  const connection = { async startSession() { return session; }, collection(name) {
    return { careclosurejobs: jobs, careaccountlifecycles: lifecycles, carefamilies: families,
      careprofiles: profiles, carefundings: fundings }[name];
  } };
  const session = { async withTransaction(callback) { await callback(session); }, async endSession() {} };
  const encryption = { open(value) { return value.state || value; }, seal(value) { return { state: value }; } };
  const step = createCareClosureAccessStep({ connection, encryption, now: () => 1700000000000 });
  return { step, jobs, profiles, fundings, operationId, job };
}

async function expectCode(promise, code) {
  try { await promise; throw new Error(`expected ${code}`); } catch (error) { expect(error.code).to.equal(code); }
}

describe('care closure access step', function() {
  it('rejects before access changes when family data is incomplete', async function() {
    const f = factory({ jobStatus: 'account_cleanup' });
    await expectCode(f.step.run('owner-1', 'op-1'), 'CLOSURE_DATA_NOT_COMPLETE');
    expect(f.profiles.calls.updateOne).to.have.length(0);
  });

  it('rejects a closing scope mismatch before member lookup', async function() {
    const f = factory({ lifecycle: { _id: 'owner-1', status: 'closing', closure: { status: 'closing', owner: 'owner-1', operationId: 'other-op' } } });
    await expectCode(f.step.run('owner-1', 'op-1'), 'CLOSURE_SCOPE_MISMATCH');
    expect(f.profiles.calls.findOne).to.have.length(0);
  });

  it('rejects an owned funding record before removing its grant', async function() {
    const f = factory({ funding: { _id: 'fund-1', owner: 'owner-1', members: ['owner-1'], rev: 0, sealed: { state: { grants: { 'owner-1': ['read'] }, receipts: {} } } } });
    await expectCode(f.step.run('owner-1', 'op-1'), 'FUNDING_TRANSFER_REQUIRED');
    expect(f.fundings.calls.updateOne).to.have.length(0);
  });

  it('rejects an unsettled receipt before removing an institutional grant', async function() {
    const f = factory({ funding: { _id: 'fund-1', owner: 'institution-1', members: ['owner-1'], rev: 0, sealed: { state: { grants: { 'owner-1': ['read'] }, receipts: { x: { actor: 'owner-1', status: 'reserved' } } } } } });
    await expectCode(f.step.run('owner-1', 'op-1'), 'CLOSURE_RECONCILIATION_REQUIRED');
    expect(f.fundings.calls.updateOne).to.have.length(0);
  });

  it('removes only the closing account grant while preserving profile data and other grants', async function() {
    const profile = {
      _id: 'profile-1', familyId: 'family-1', members: ['owner-1', 'member-2'], rev: 0,
      sealed: { state: { grants: { 'owner-1': ['read'], 'member-2': ['read', 'edit'] }, relationships: { 'owner-1': { role: 'relative' }, 'member-2': { role: 'patient' } }, invites: { invite: { acceptedBy: 'member-2' } }, resources: { note: { value: 'keep' } }, audit: [{ actor: 'member-2' }] } }
    };
    const f = factory({ profile });
    const result = await f.step.run('owner-1', 'op-1');
    expect(result).to.deep.equal({ status: 'access_revoked', count: 1 });
    const saved = f.profiles.calls.updateOne[0].update.$set.sealed.state;
    expect(saved.grants).to.deep.equal({ 'member-2': ['read', 'edit'] });
    expect(saved.relationships).to.deep.equal({ 'member-2': { role: 'patient' } });
    expect(saved.invites).to.deep.equal({ invite: { acceptedBy: 'member-2' } });
    expect(saved.resources).to.deep.equal({ note: { value: 'keep' } });
    expect(saved.audit).to.deep.equal([{ actor: 'member-2' }]);
    expect(f.profiles.calls.updateOne[0].update.$set.members).to.deep.equal(['member-2']);
    expect(f.job.status).to.equal('access_revoked');
  });
});

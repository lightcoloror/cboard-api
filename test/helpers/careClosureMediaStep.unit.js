'use strict';

const chai = require('chai');
const { createCareClosureMediaStep } = require('../../api/helpers/careClosureMediaStep');

const expect = chai.expect;

function collection(docs, update) {
  const calls = { findOne: [], updateOne: [] };
  return {
    calls,
    async findOne(filter) {
      calls.findOne.push(filter);
      return docs.find(item => item._id === filter._id && (!filter.owner || item.owner === filter.owner)) || null;
    },
    async updateOne(filter, change) {
      calls.updateOne.push({ filter, change });
      return update ? update(filter, change) : { matchedCount: 1 };
    }
  };
}

function factory({ plan = {}, status = 'prepared', cursor, rev = 0, media = [], account, family, funding, remove, update } = {}) {
  const operationId = 'op-1';
  const lifecyclePlan = {
    owner: 'owner-1', familyIds: ['family-1'], media, pendingUsage: [], pendingUploads: [], institutionAdminIds: [], ...plan
  };
  const job = { _id: operationId, owner: 'owner-1', status, rev, sealed: { plan: lifecyclePlan }, ...(cursor === undefined ? {} : { mediaCursor: cursor }) };
  const jobs = collection([job], (filter, change) => {
    if (update && !update(filter, change)) return { matchedCount: 0 };
    if (filter.rev !== job.rev) return { matchedCount: 0 };
    if (change.$set) Object.assign(job, change.$set);
    if (change.$inc) job.rev += change.$inc.rev || 0;
    return { matchedCount: 1 };
  });
  const accounts = collection([account || { _id: 'owner-1', status: 'closing', closure: { status: 'closing', owner: 'owner-1', operationId, familyIds: ['family-1'] } }]);
  const families = collection([family || { _id: 'family-1', owner: 'owner-1', closure: { status: 'closing', owner: 'owner-1', operationId }, sealed: { state: {} } }]);
  const fundings = collection(funding ? [funding] : []);
  const connection = { collection(name) { return { careclosurejobs: jobs, careaccountlifecycles: accounts, carefamilies: families, carefundings: fundings }[name]; } };
  const removed = [];
  const encryption = { open(value) { return value.plan || value.state || value; } };
  const step = createCareClosureMediaStep({ connection, encryption, media: { async remove(blob) { removed.push(blob); if (remove) await remove(blob, removed.length); } }, maxPerRun: 20, now: () => 1700000000000 });
  return { step, jobs, accounts, families, fundings, job, plan: lifecyclePlan, removed, operationId };
}

function media(id, blob = `${id}.bin`) {
  return { familyId: 'family-1', profileId: 'profile-1', mediaId: id, blob };
}

async function expectCode(promise, code) {
  try { await promise; throw new Error(`expected ${code}`); } catch (error) { expect(error.code).to.equal(code); }
}

describe('care closure media step', function() {
  it('checkpoints after each idempotent removal and resumes after a middle failure', async function() {
    const f = factory({ media: [media('b'), media('a'), media('c')] });
    let failed = true;
    f.step = createCareClosureMediaStep({
      connection: { collection(name) { return { careclosurejobs: f.jobs, careaccountlifecycles: f.accounts, carefamilies: f.families, carefundings: f.fundings }[name]; } },
      encryption: { open(value) { return value.plan || value.state || value; } }, maxPerRun: 20,
      media: { async remove(blob) { f.removed.push(blob); if (blob === 'c.bin' && failed) { failed = false; throw new Error('temporary'); } } }
    });
    await expectCode(f.step.run('owner-1', f.operationId), 'CLOSURE_MEDIA_RETRY_REQUIRED');
    expect(f.job.mediaCursor).to.equal(2);
    expect(await f.step.run('owner-1', f.operationId)).to.deep.equal({ status: 'media_cleaned', count: 1 });
    expect(f.removed).to.deep.equal(['a.bin', 'b.bin', 'c.bin', 'c.bin']);
  });

  it('does not repeat checkpointed media on the next run', async function() {
    const f = factory({ media: [media('a'), media('b')], cursor: 1 });
    expect(await f.step.run('owner-1', f.operationId)).to.deep.equal({ status: 'media_cleaned', count: 1 });
    expect(f.removed).to.deep.equal(['b.bin']);
  });

  it('waits on a reserved usage receipt without deleting media', async function() {
    const f = factory({ media: [media('a')], plan: { pendingUsage: [{ fundingId: 'fund-1', actor: 'owner-1', requestId: 'request-1', profileId: 'profile-1' }] }, funding: { _id: 'fund-1', sealed: { state: { receipts: { x: { actor: 'owner-1', requestId: 'request-1', profileId: 'profile-1', status: 'reserved' } } } } } });
    expect(await f.step.run('owner-1', f.operationId)).to.deep.equal({ status: 'waiting', count: 0 });
    expect(f.removed).to.deep.equal([]);
  });

  it('rejects a job whose account or family closure scope does not match', async function() {
    const f = factory({ media: [], account: { _id: 'owner-1', status: 'closing', closure: { status: 'closing', owner: 'owner-1', operationId: 'other-op', familyIds: ['family-1'] } } });
    await expectCode(f.step.run('owner-1', f.operationId), 'CLOSURE_SCOPE_MISMATCH');
    expect(f.removed).to.deep.equal([]);
  });

  it('checkpoints an empty media plan as cleaned', async function() {
    const f = factory({ media: [] });
    expect(await f.step.run('owner-1', f.operationId)).to.deep.equal({ status: 'media_cleaned', count: 0 });
    expect(f.job.status).to.equal('media_cleaned');
    expect(f.job.mediaCursor).to.equal(0);
  });

  it('does not advance the cursor when checkpoint CAS fails', async function() {
    const f = factory({ media: [media('a')], update: () => false });
    expect(await f.step.run('owner-1', f.operationId)).to.deep.equal({ status: 'prepared', count: 0 });
    expect(f.removed).to.deep.equal(['a.bin']);
    expect(f.job.mediaCursor).to.equal(undefined);
  });
});

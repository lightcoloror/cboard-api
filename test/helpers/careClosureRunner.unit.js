'use strict';

const chai = require('chai');
const { createCareClosureRunner } = require('../../api/helpers/careClosureRunner');

const expect = chai.expect;

function factory(initial, transitions = {}, finalize = null) {
  const calls = { inspect: [], media: 0, accounts: 0, data: 0, access: 0, finalize: 0 };
  const state = { operationId: 'op-1', cleanupStatus: initial };
  const coordinator = {
    async inspect(owner, operationId) {
      calls.inspect.push({ owner, operationId });
      return { ...state };
    }
  };
  function stage(name) {
    return { async run() {
      calls[name] += 1;
      const transition = transitions[name];
      if (typeof transition === 'function') return transition(state);
      if (transition) state.cleanupStatus = transition;
      return { status: state.cleanupStatus };
    } };
  }
  const runner = createCareClosureRunner({ coordinator, mediaStep: stage('media'), accountStep: stage('accounts'), dataStep: stage('data'), accessStep: stage('access'), finalizeStep: finalize && stage('finalize') });
  return { runner, calls, state };
}

async function expectCode(promise, code) {
  try { await promise; throw new Error(`expected ${code}`); } catch (error) { expect(error.code).to.equal(code); }
}

describe('care closure runner', function() {
  it('runs persisted media, account, data, and access stages serially', async function() {
    const f = factory('prepared', { media: 'media_cleaned', accounts: 'accounts_cleaned', data: 'family_data_cleaned', access: 'access_revoked' });
    const result = await f.runner.run('owner-1', 'op-1');
    expect(result).to.deep.equal({ operationId: 'op-1', cleanupStatus: 'access_revoked', waiting: false, accountDeleted: false });
    expect(f.calls.media).to.equal(1);
    expect(f.calls.accounts).to.equal(1);
    expect(f.calls.data).to.equal(1);
    expect(f.calls.access).to.equal(1);
  });

  it('returns waiting after media reports a pending blocker without advancing', async function() {
    const f = factory('prepared', { media: () => ({ status: 'waiting' }) });
    const result = await f.runner.run('owner-1', 'op-1');
    expect(result).to.deep.equal({ operationId: 'op-1', cleanupStatus: 'prepared', waiting: true, accountDeleted: false });
    expect(f.calls.media).to.equal(1);
    expect(f.calls.accounts).to.equal(0);
    expect(f.calls.data).to.equal(0);
  });

  it('stops after a media partial-progress response instead of looping', async function() {
    const f = factory('media_cleanup', { media: () => ({ status: 'media_cleanup' }) });
    const result = await f.runner.run('owner-1', 'op-1');
    expect(result.cleanupStatus).to.equal('media_cleanup');
    expect(result.waiting).to.equal(false);
    expect(f.calls.media).to.equal(1);
    expect(f.calls.accounts).to.equal(0);
  });

  it('propagates stage failures without swallowing them', async function() {
    const f = factory('prepared', { media: () => { throw Object.assign(new Error('media failed'), { code: 'CLOSURE_MEDIA_RETRY_REQUIRED' }); } });
    await expectCode(f.runner.run('owner-1', 'op-1'), 'CLOSURE_MEDIA_RETRY_REQUIRED');
    expect(f.calls.accounts).to.equal(0);
  });

  it('resumes from persisted accounts_cleaned state at the data stage', async function() {
    const f = factory('accounts_cleaned', { data: 'family_data_cleaned', access: 'access_revoked' });
    const result = await f.runner.run('owner-1', 'op-1');
    expect(result.cleanupStatus).to.equal('access_revoked');
    expect(f.calls.media).to.equal(0);
    expect(f.calls.accounts).to.equal(0);
    expect(f.calls.data).to.equal(1);
    expect(f.calls.access).to.equal(1);
  });

  it('returns a terminal response with accountDeleted false', async function() {
    const f = factory('access_revoked');
    const result = await f.runner.run('owner-1', 'op-1');
    expect(result).to.deep.equal({ operationId: 'op-1', cleanupStatus: 'access_revoked', waiting: false, accountDeleted: false });
    expect(f.calls.media + f.calls.accounts + f.calls.data + f.calls.access).to.equal(0);
  });

  it('runs finalize as the fifth stage and trusts persisted complete status', async function() {
    const f = factory('prepared', { media: 'media_cleaned', accounts: 'accounts_cleaned', data: 'family_data_cleaned', access: 'access_revoked', finalize: 'complete' }, {});
    const result = await f.runner.run('owner-1', 'op-1');
    expect(result).to.deep.equal({ operationId: 'op-1', cleanupStatus: 'complete', waiting: false, accountDeleted: true });
    expect(f.calls.media + f.calls.accounts + f.calls.data + f.calls.access + f.calls.finalize).to.equal(5);
  });

  it('resumes account cleanup from a persisted pending status', async function() {
    const f = factory('account_cleanup_pending', { finalize: 'complete' }, {});
    const result = await f.runner.run('owner-1', 'op-1');
    expect(result.accountDeleted).to.equal(true);
    expect(result.cleanupStatus).to.equal('complete');
    expect(f.calls.finalize).to.equal(1);
  });

  it('does not report deletion from a finalize step that only claims complete', async function() {
    const f = factory('access_revoked', { finalize: () => ({ status: 'complete' }) }, {});
    const result = await f.runner.run('owner-1', 'op-1');
    expect(result).to.deep.equal({ operationId: 'op-1', cleanupStatus: 'access_revoked', waiting: false, accountDeleted: false });
    expect(f.calls.finalize).to.equal(1);
  });

  it('does not run finalize for a persisted complete terminal state', async function() {
    const f = factory('complete', {}, {});
    const result = await f.runner.run('owner-1', 'op-1');
    expect(result).to.deep.equal({ operationId: 'op-1', cleanupStatus: 'complete', waiting: false, accountDeleted: true });
    expect(f.calls.finalize).to.equal(0);
  });

  it('propagates cleanup in progress errors from finalize', async function() {
    const f = factory('access_revoked', { finalize: () => { throw Object.assign(new Error('cleanup pending'), { code: 'CLOSURE_CLEANUP_IN_PROGRESS' }); } }, {});
    await expectCode(f.runner.run('owner-1', 'op-1'), 'CLOSURE_CLEANUP_IN_PROGRESS');
  });

  it('returns waiting after access reports a pending blocker without advancing', async function() {
    const f = factory('family_data_cleaned', { access: () => ({ status: 'waiting' }) });
    const result = await f.runner.run('owner-1', 'op-1');
    expect(result).to.deep.equal({ operationId: 'op-1', cleanupStatus: 'family_data_cleaned', waiting: true, accountDeleted: false });
    expect(f.calls.access).to.equal(1);
  });

  it('fails closed on unknown status and respects maxStages', async function() {
    const unknown = factory('mystery');
    await expectCode(unknown.runner.run('owner-1', 'op-1'), 'CLOSURE_STAGE_UNAVAILABLE');
    let boundedStatus = 'prepared';
    const boundedRunner = createCareClosureRunner({
      coordinator: { inspect: async () => ({ operationId: 'op-1', cleanupStatus: boundedStatus }) },
      mediaStep: { run: async () => { boundedStatus = 'media_cleaned'; return { status: 'media_cleaned' }; } },
      accountStep: { run: async () => ({ status: 'accounts_cleaned' }) },
      dataStep: { run: async () => ({ status: 'family_data_cleaned' }) },
      accessStep: { run: async () => ({ status: 'access_revoked' }) },
      maxStages: 1
    });
    const result = await boundedRunner.run('owner-1', 'op-1');
    expect(result.cleanupStatus).to.equal('media_cleaned');
  });
});

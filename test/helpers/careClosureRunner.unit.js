'use strict';

const chai = require('chai');
const { createCareClosureRunner } = require('../../api/helpers/careClosureRunner');

const expect = chai.expect;

function factory(initial, transitions = {}) {
  const calls = { inspect: [], media: 0, accounts: 0, data: 0 };
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
  const runner = createCareClosureRunner({ coordinator, mediaStep: stage('media'), accountStep: stage('accounts'), dataStep: stage('data') });
  return { runner, calls, state };
}

async function expectCode(promise, code) {
  try { await promise; throw new Error(`expected ${code}`); } catch (error) { expect(error.code).to.equal(code); }
}

describe('care closure runner', function() {
  it('runs persisted media, account, and data stages serially', async function() {
    const f = factory('prepared', { media: 'media_cleaned', accounts: 'accounts_cleaned', data: 'family_data_cleaned' });
    const result = await f.runner.run('owner-1', 'op-1');
    expect(result).to.deep.equal({ operationId: 'op-1', cleanupStatus: 'family_data_cleaned', waiting: false, accountDeleted: false });
    expect(f.calls.media).to.equal(1);
    expect(f.calls.accounts).to.equal(1);
    expect(f.calls.data).to.equal(1);
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
    const f = factory('accounts_cleaned', { data: 'family_data_cleaned' });
    const result = await f.runner.run('owner-1', 'op-1');
    expect(result.cleanupStatus).to.equal('family_data_cleaned');
    expect(f.calls.media).to.equal(0);
    expect(f.calls.accounts).to.equal(0);
    expect(f.calls.data).to.equal(1);
  });

  it('returns a terminal response with accountDeleted false', async function() {
    const f = factory('family_data_cleaned');
    const result = await f.runner.run('owner-1', 'op-1');
    expect(result).to.deep.equal({ operationId: 'op-1', cleanupStatus: 'family_data_cleaned', waiting: false, accountDeleted: false });
    expect(f.calls.media + f.calls.accounts + f.calls.data).to.equal(0);
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
      maxStages: 1
    });
    const result = await boundedRunner.run('owner-1', 'op-1');
    expect(result.cleanupStatus).to.equal('media_cleaned');
  });
});

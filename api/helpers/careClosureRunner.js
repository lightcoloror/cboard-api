'use strict';

const { fail } = require('./carePolicy');
const phases = Object.assign(Object.create(null), {
  prepared: 'media', media_cleanup: 'media',
  media_cleaned: 'accounts', account_cleanup: 'accounts',
  accounts_cleaned: 'data', family_data_cleaned: 'access', access_cleanup: 'access',
  access_revoked: 'finalize', account_cleanup_pending: 'finalize', complete: 'done'
});

// A bounded invocation of existing durable stages, not a background scheduler.
// Persisted job status is authoritative after every step, including a lost CAS.
function createCareClosureRunner({ coordinator, mediaStep, accountStep, dataStep, accessStep, finalizeStep = null, maxStages = 5 }) {
  if (!Number.isSafeInteger(maxStages) || maxStages < 1 || maxStages > 5) throw new TypeError('Invalid closure stage limit');
  const steps = { media: mediaStep, accounts: accountStep, data: dataStep, access: accessStep, finalize: finalizeStep };
  if (!coordinator || typeof coordinator.inspect !== 'function' ||
    Object.entries(steps).some(([name, step]) => name !== 'finalize' && (!step || typeof step.run !== 'function')) ||
    (finalizeStep !== null && typeof finalizeStep.run !== 'function')) throw new TypeError('Closure stages required');
  const response = (job, waiting = false) => ({ operationId: job.operationId,
    cleanupStatus: job.cleanupStatus, waiting, accountDeleted: job.cleanupStatus === 'complete' });
  return { async run(owner, operationId) {
    let job = await coordinator.inspect(owner, operationId);
    for (let count = 0; count < maxStages; count++) {
      const phase = phases[job.cleanupStatus];
      if (!phase) fail(503, 'CLOSURE_STAGE_UNAVAILABLE');
      if (phase === 'done') return response(job);
      if (phase === 'finalize' && !finalizeStep) return response(job);
      const result = await steps[phase].run(owner, operationId);
      job = await coordinator.inspect(owner, operationId);
      if (!phases[job.cleanupStatus]) fail(503, 'CLOSURE_STAGE_UNAVAILABLE');
      if (result.status === 'waiting') return response(job, true);
      if (phases[job.cleanupStatus] === phase) return response(job);
    }
    return response(job);
  } };
}
module.exports = { createCareClosureRunner };

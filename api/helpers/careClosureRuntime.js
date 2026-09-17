'use strict';

const mongoose = require('mongoose');
const careCrypto = require('./careCrypto');
const { createCareClosureReceipt } = require('./careClosureReceipt');
const { createCareClosureCoordinator } = require('./careClosureCoordinator');
const { createCareClosureMediaStep } = require('./careClosureMediaStep');
const { createCareClosureAccountStep } = require('./careClosureAccountStep');
const { createCareClosureDataStep } = require('./careClosureDataStep');
const { createCareClosureAccessStep } = require('./careClosureAccessStep');
const { createCareClosureFinalize } = require('./careClosureFinalize');
const { createCareClosureRunner } = require('./careClosureRunner');

// Internal composition only. This factory wires the durable closure stages;
// it does not expose HTTP or start a scheduler, and no stage runs at build time.
function createCareClosureRuntime({
  connection = mongoose.connection,
  encryption = careCrypto.fromEnvironment(),
  media,
  cleanup,
  revokeSessions,
  now = Date.now,
  maxPerRun = 20
} = {}) {
  if (!media || typeof media.remove !== 'function') {
    throw new TypeError('Media remove adapter is required');
  }
  if (typeof cleanup !== 'function' || typeof revokeSessions !== 'function') {
    throw new TypeError('Account cleanup adapters are required');
  }
  if (!Number.isSafeInteger(maxPerRun) || maxPerRun < 1) {
    throw new TypeError('Invalid closure run limit');
  }

  const receipt = createCareClosureReceipt({ connection, lifecycle: null, now });
  const coordinator = createCareClosureCoordinator({ connection, encryption, receipt });
  const mediaStep = createCareClosureMediaStep({ connection, encryption, media, maxPerRun, now });
  const accountStep = createCareClosureAccountStep({ connection, encryption, maxPerRun, now });
  const dataStep = createCareClosureDataStep({ connection, encryption, now });
  const accessStep = createCareClosureAccessStep({ connection, encryption, maxPerRun, now });
  const finalizeStep = createCareClosureFinalize({ connection, encryption, cleanup, revokeSessions, now });
  const runner = createCareClosureRunner({
    coordinator,
    mediaStep,
    accountStep,
    dataStep,
    accessStep,
    finalizeStep,
    maxStages: 5
  });

  return { receipt, coordinator, runner };
}

module.exports = { createCareClosureRuntime };

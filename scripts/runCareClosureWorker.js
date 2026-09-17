'use strict';

// One bounded batch. Scheduling and deployment remain explicit operator steps.
// Do not import db.js: it starts application seeds and unrelated startup writes.
async function main({ env = process.env } = {}) {
  if (env.CARE_COLLABORATION_ENABLED !== 'true' ||
      env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED !== 'true' ||
      env.CARE_CLOSURE_WORKER_ENABLED !== 'true') {
    throw Object.assign(new Error('Closure worker disabled'), { code: 'CLOSURE_WORKER_DISABLED' });
  }
  const uri = env.CARE_CLOSURE_MONGO_URI;
  if (typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\/\S+$/.test(uri)) {
    throw Object.assign(new Error('Explicit closure database required'), { code: 'CLOSURE_WORKER_DATABASE_REQUIRED' });
  }
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 0) {
    throw Object.assign(new Error('Dedicated worker connection required'), { code: 'CLOSURE_WORKER_CONNECTION_IN_USE' });
  }
  try {
    await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true,
      serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000 });
    const connection = mongoose.connection;
    // Shared and legacy private archives use their existing storage adapters.
    const quotaService = require('../api/helpers/communicationAiTokenQuota')
      .createCommunicationAiTokenQuotaService({ storeClient: connection });
    const runtime = require('../api/helpers/careClosureRuntime').createCareClosureRuntime({
      connection,
      media: require('../api/helpers/careRuntime').getMediaAdapter(),
      revokeSessions: owner => require('../api/helpers/deviceSessions').revoke(owner),
      cleanup: args => require('../api/controllers/account').cleanupAccountData({ ...args, quotaService })
    });
    return await require('../api/helpers/careClosureWorker').createCareClosureWorker({
      connection, runner: runtime.runner
    }).runBatch();
  } finally { await mongoose.disconnect(); }
}

if (require.main === module) {
  main().then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.failed > 0 || result.needsAttention > 0) process.exitCode = 2;
  }).catch(error => {
    const code = error && typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code)
      ? error.code : 'CLOSURE_WORKER_FAILED';
    process.stderr.write(JSON.stringify({ code }) + '\n');
    process.exitCode = 1;
  });
}
module.exports = { main };

'use strict';

// Read-only, one-job inspection.  This deliberately avoids db.js and the
// closure worker so it cannot seed data, schedule work, or decrypt archives.
const RESERVED_OPERATION_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function requireOperationId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw Object.assign(new Error('Closure operation id required'), {
      code: 'CLOSURE_INSPECT_OPERATION_REQUIRED'
    });
  }
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value) || RESERVED_OPERATION_IDS.has(value)) {
    throw Object.assign(new Error('Closure operation id invalid'), {
      code: 'CLOSURE_INSPECT_OPERATION_INVALID'
    });
  }
  return value;
}

async function main({ env = process.env } = {}) {
  const operationId = requireOperationId(env.CARE_CLOSURE_OPERATION_ID);
  const uri = env.CARE_CLOSURE_MONGO_URI;
  if (typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\/\S+$/.test(uri)) {
    throw Object.assign(new Error('Explicit closure database required'), {
      code: 'CLOSURE_INSPECT_DATABASE_REQUIRED'
    });
  }

  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 0) {
    throw Object.assign(new Error('Dedicated inspection connection required'), {
      code: 'CLOSURE_INSPECT_CONNECTION_IN_USE'
    });
  }

  try {
    await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000
    });
    return await require('../api/helpers/careClosureDiagnostics')
      .inspectCareClosureJob({ connection: mongoose.connection, operationId });
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
  }).catch(error => {
    const code = error && typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code)
      ? error.code
      : 'CLOSURE_INSPECT_FAILED';
    process.stderr.write(JSON.stringify({ code }) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { main, requireOperationId };

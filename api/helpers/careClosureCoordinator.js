'use strict';

const mongoose = require('mongoose');
const { createCareFamilyLifecycle } = require('./careFamilyLifecycle');
const { buildCareClosurePlan } = require('./careClosurePlan');
const { fail } = require('./carePolicy');
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);

// Internal preparation only. No HTTP handler or destructive worker is enabled.
// Reuse the account lifecycle operation id and Mongo transaction rather than
// introducing a second queue or an in-memory retry state.
function createCareClosureCoordinator({
  connection = mongoose.connection,
  encryption = require('./careCrypto').fromEnvironment(),
  maxScanRecords = 1000
} = {}) {
  if (!Number.isSafeInteger(maxScanRecords) || maxScanRecords < 1 || maxScanRecords > 10000) {
    throw new TypeError('Invalid closure scan limit');
  }
  const families = connection.collection('carefamilies');
  const profiles = connection.collection('careprofiles');
  const fundings = connection.collection('carefundings');
  const accounts = connection.collection('careaccounts');
  const jobs = connection.collection('careclosurejobs');

  async function boundedRead(collection, filter, session) {
    const docs = await collection.find(filter, { session }).limit(maxScanRecords + 1).toArray();
    if (docs.length > maxScanRecords) fail(503, 'CLOSURE_SCAN_LIMIT_REACHED');
    return docs;
  }

  const lifecycle = createCareFamilyLifecycle({ connection,
    Family: { collection: families }, Profile: { collection: profiles },
    prepareClose: async (session, closure) => {
      // The encrypted account/funding contents cannot be queried by profile.
      // A bounded full scan fails explicitly instead of silently missing a
      // revoked collaborator's pending receipt or private favorite reference.
      const familyDocs = await boundedRead(families, { _id: { $in: closure.familyIds } }, session);
      const profileDocs = await boundedRead(profiles, { familyId: { $in: closure.familyIds } }, session);
      const fundingDocs = await boundedRead(fundings, {}, session);
      const accountDocs = await boundedRead(accounts, {}, session);
      const plan = buildCareClosurePlan({ owner: closure.owner, familyIds: closure.familyIds,
        families: familyDocs, profiles: profileDocs, fundings: fundingDocs, accounts: accountDocs, encryption });
      // Transfer institution administration before freezing the account;
      // deleting one account must never strand a shared institution balance.
      if (plan.institutionAdminIds.length) fail(409, 'INSTITUTION_TRANSFER_REQUIRED');
      if (fundingDocs.some(funding => funding.owner === closure.owner &&
        !(funding.kind === 'family' && closure.familyIds.includes(funding.familyId)))) fail(409, 'FUNDING_TRANSFER_REQUIRED');
      await jobs.insertOne({ _id: closure.operationId, owner: closure.owner, rev: 0,
        status: 'prepared', createdAt: closure.at, updatedAt: closure.at,
        sealed: encryption.seal(plan, `closure:${closure.operationId}`) }, { session });
    }
  });

  async function inspect(owner, operationId) {
    if (!validId(owner) || !validId(operationId)) fail(400, 'INVALID_CLOSURE_JOB');
    const job = await jobs.findOne({ _id: operationId, owner });
    if (!job) fail(503, 'CLOSURE_JOB_UNAVAILABLE');
    // Do not return encrypted manifests or data references to a status caller.
    return { operationId: job._id, cleanupStatus: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt };
  }

  return {
    async begin(owner, exactFamilyIds) {
      const result = await lifecycle.beginClose(owner, exactFamilyIds);
      return { ...result, ...await inspect(owner, result.operationId) };
    },
    inspect
  };
}

module.exports = { createCareClosureCoordinator };

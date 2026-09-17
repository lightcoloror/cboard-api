'use strict';

const mongoose = require('mongoose');
const { createCareFamilyLifecycle, TRANSACTION_OPTIONS } = require('./careFamilyLifecycle');
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
  receipt = null,
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

  async function boundedRead(collection, filter, session, projection) {
    const docs = await collection.find(filter, { session, ...(projection ? { projection } : {}) }).limit(maxScanRecords + 1).toArray();
    if (docs.length > maxScanRecords) fail(503, 'CLOSURE_SCAN_LIMIT_REACHED');
    return docs;
  }

  const lifecycleFor = secret => createCareFamilyLifecycle({ connection,
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
      if (secret !== undefined) await receipt.bind(closure.owner, secret, closure.operationId, session);
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

  async function preview(owner) {
    if (!validId(owner)) fail(400, 'INVALID_OWNER');
    const session = await connection.startSession();
    let result;
    try {
      await session.withTransaction(async current => {
        const account = await connection.collection('careaccountlifecycles').findOne({ _id: owner }, { session: current });
        if (account && account.status !== 'open') {
          fail(409, account.status === 'closing' ? 'ACCOUNT_CLOSING' : account.status === 'closed' ? 'ACCOUNT_CLOSED' : 'ACCOUNT_CLOSE_CONFLICT');
        }
        const owned = await boundedRead(families, { owner }, current, { _id: 1, closure: 1 });
        if (owned.some(family => family.closure && family.closure.status !== 'open')) fail(409, 'FAMILY_CLOSE_CONFLICT');
        const familyIds = owned.map(family => family._id);
        if (familyIds.some(id => !validId(id)) || new Set(familyIds).size !== familyIds.length) fail(503, 'CLOSURE_SCOPE_MISMATCH');
        familyIds.sort();
        const patientDocs = familyIds.length ? await boundedRead(profiles, { familyId: { $in: familyIds } }, current, { _id: 1, familyId: 1, members: 1 }) : [];
        const fundingDocs = await boundedRead(fundings, { owner }, current, { _id: 1, kind: 1, familyId: 1 });
        const transferFamilies = new Set(patientDocs.filter(profile => {
          const members = Array.isArray(profile.members) ? [...new Set(profile.members.map(String))] : [];
          return members.length !== 1 || members[0] !== owner;
        }).map(profile => profile.familyId));
        const blockers = [];
        if (transferFamilies.size) blockers.push({ code: 'FAMILY_TRANSFER_REQUIRED', familyIds: [...transferFamilies].sort() });
        const institutions = fundingDocs.filter(funding => funding.kind === 'institution').map(funding => funding._id).sort();
        if (institutions.length) blockers.push({ code: 'INSTITUTION_TRANSFER_REQUIRED', fundingIds: institutions });
        const otherFunding = fundingDocs.filter(funding => funding.kind !== 'institution' &&
          !(funding.kind === 'family' && familyIds.includes(funding.familyId))).map(funding => funding._id).sort();
        if (otherFunding.length) blockers.push({ code: 'FUNDING_TRANSFER_REQUIRED', fundingIds: otherFunding });
        result = {
          familyIds,
          families: familyIds.map(familyId => ({ familyId,
            profileCount: patientDocs.filter(profile => profile.familyId === familyId).length,
            requiresTransfer: transferFamilies.has(familyId) })),
          blockers, canConfirm: blockers.length === 0,
          confirmationRequired: true, revalidationRequired: true,
          deletesCloudData: true, preservesLocalData: true
        };
      }, TRANSACTION_OPTIONS);
    } finally { await session.endSession(); }
    return result;
  }

  return {
    async begin(owner, exactFamilyIds, secret) {
      if (secret !== undefined) {
        if (!receipt) fail(503, 'CLOSURE_RECEIPT_UNAVAILABLE');
        await receipt.inspect(owner, secret);
      }
      const result = await lifecycleFor(secret).beginClose(owner, exactFamilyIds);
      if (secret !== undefined) {
        const status = await receipt.inspect(owner, secret);
        if (status.operationId !== result.operationId) fail(409, 'CLOSURE_SCOPE_MISMATCH');
      }
      return { ...result, ...await inspect(owner, result.operationId) };
    },
    inspect,
    preview
  };
}

module.exports = { createCareClosureCoordinator };

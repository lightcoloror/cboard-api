'use strict';

const mongoose = require('mongoose');
const { createCareFamilyLifecycle } = require('./careFamilyLifecycle');

function fail(status, code, details) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function validObjectIdString(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{24}$/i.test(value) &&
    mongoose.Types.ObjectId.isValid(value)
  );
}

function normalizeOwnerEmails(ownerEmails) {
  if (!Array.isArray(ownerEmails) || !ownerEmails.length) {
    fail(400, 'LEGACY_OWNER_UNAVAILABLE');
  }
  const normalized = [];
  const seen = new Set();
  for (const value of ownerEmails) {
    if (typeof value !== 'string' || !value.trim()) {
      fail(400, 'LEGACY_OWNER_UNAVAILABLE');
    }
    const email = value.trim();
    if (!seen.has(email)) {
      seen.add(email);
      normalized.push(email);
    }
  }
  return normalized;
}

function createLegacyAccountWrite({
  connection = mongoose.connection,
  lifecycle = null,
  enabled = () => process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true'
} = {}) {
  async function withLegacyAccountWrite(actorId, ownerEmails, callback) {
    if (!enabled()) return callback(null);
    if (!validObjectIdString(actorId)) fail(400, 'LEGACY_OWNER_UNAVAILABLE');
    if (typeof callback !== 'function') fail(400, 'INVALID_LEGACY_CALLBACK');

    const emails = normalizeOwnerEmails(ownerEmails);
    if (!connection || typeof connection.collection !== 'function') {
      fail(503, 'LEGACY_OWNER_UNAVAILABLE');
    }
    const users = connection.collection('users');
    const owners = new Map();
    for (const email of emails) {
      const matches = await users.find({ email }).limit(2).toArray();
      if (!Array.isArray(matches) || matches.length !== 1) {
        fail(409, 'LEGACY_OWNER_UNAVAILABLE', { email });
      }
      const owner = matches[0];
      if (!owner || !owner._id || !validObjectIdString(String(owner._id))) {
        fail(409, 'LEGACY_OWNER_UNAVAILABLE', { email });
      }
      owners.set(email, { id: String(owner._id), email });
    }

    const accountIds = [actorId, ...[...owners.values()].map(owner => owner.id)];
    const activeLifecycle = lifecycle || createCareFamilyLifecycle({ connection });
    return activeLifecycle.withOpenFamilyAccounts(
      null,
      accountIds,
      async session => {
        const actor = await users.findOne(
          { _id: new mongoose.Types.ObjectId(actorId) },
          { session }
        );
        if (!actor) fail(409, 'ACCOUNT_UNAVAILABLE');

        for (const owner of owners.values()) {
          const current = await users.findOne(
            {
              _id: new mongoose.Types.ObjectId(owner.id),
              email: owner.email
            },
            { session }
          );
          if (!current) {
            fail(409, 'LEGACY_OWNER_CHANGED', { email: owner.email });
          }
        }
        return callback(session);
      }
    );
  }

  return { withLegacyAccountWrite };
}

const defaultService = createLegacyAccountWrite();

module.exports = {
  createLegacyAccountWrite,
  withLegacyAccountWrite: (...args) =>
    defaultService.withLegacyAccountWrite(...args)
};

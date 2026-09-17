'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { Family: DefaultFamily, Profile: DefaultProfile } = require('../models/CareWorkspace');

const FAMILY_ACCESS_DENIED = 'FAMILY_ACCESS_DENIED';
const FAMILY_CLOSED = 'FAMILY_CLOSED';
const FAMILY_CLOSING = 'FAMILY_CLOSING';
const FAMILY_CLOSE_CONFLICT = 'FAMILY_CLOSE_CONFLICT';
const FAMILY_CLOSE_CONFIRMATION_REQUIRED = 'FAMILY_CLOSE_CONFIRMATION_REQUIRED';
const FAMILY_TRANSFER_REQUIRED = 'FAMILY_TRANSFER_REQUIRED';

const TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary'
});

function fail(status, code, details) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function validId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) &&
    !['__proto__', 'constructor', 'prototype'].includes(value);
}

function modelCollection(model, name) {
  if (!model || !model.collection) throw new Error(`${name} collection is required`);
  return model.collection;
}

function changed(result) {
  return Number(result && (result.matchedCount !== undefined ? result.matchedCount : result.n)) === 1;
}

function familyStatus(family) {
  return family && family.closure && family.closure.status || 'open';
}

function assertOpen(family) {
  if (!family) fail(403, FAMILY_ACCESS_DENIED);
  const status = familyStatus(family);
  if (status === 'closed') fail(403, FAMILY_CLOSED);
  if (status === 'closing') fail(409, FAMILY_CLOSING);
  if (status !== 'open') fail(409, FAMILY_CLOSE_CONFLICT);
}

function sortedIds(values) {
  return [...values].map(String).sort();
}

function sameIdSet(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function createCareFamilyLifecycle({
  connection = mongoose.connection,
  Family = DefaultFamily,
  Profile = DefaultProfile,
  now = () => Date.now(),
  operationId = () => crypto.randomBytes(16).toString('hex')
} = {}) {
  const familyCollection = modelCollection(Family, 'Family');
  const profileCollection = modelCollection(Profile, 'Profile');

  async function transaction(callback) {
    if (!connection || typeof connection.startSession !== 'function') {
      fail(503, 'FAMILY_TRANSACTION_UNAVAILABLE');
    }
    const session = await connection.startSession();
    if (!session || typeof session.withTransaction !== 'function') {
      if (session && typeof session.endSession === 'function') await session.endSession();
      fail(503, 'FAMILY_TRANSACTION_UNAVAILABLE');
    }
    try {
      // mongodb 3.x resolves withTransaction with the commit result rather
      // than the callback's value. Preserve the helper result explicitly.
      let value;
      await session.withTransaction(async currentSession => {
        value = await callback(currentSession);
        return value;
      }, TRANSACTION_OPTIONS);
      return value;
    } finally {
      if (typeof session.endSession === 'function') await session.endSession();
    }
  }

  async function readFamily(familyId, session) {
    const family = await familyCollection.findOne({ _id: familyId }, { session });
    assertOpen(family);
    return family;
  }

  async function withOpenFamily(familyId, callback) {
    if (!validId(familyId)) fail(400, 'INVALID_FAMILY');
    if (typeof callback !== 'function') fail(400, 'INVALID_FAMILY_CALLBACK');
    // The callback must contain Mongo operations only. withTransaction may retry
    // the callback after a transient transaction error; external side effects
    // belong after the committed result is returned.
    return transaction(async session => {
      const family = await readFamily(familyId, session);
      const result = await familyCollection.updateOne({
        _id: familyId,
        $or: [
          { closure: { $exists: false } },
          { 'closure.status': 'open' }
        ]
      }, { $inc: { lifecycleRev: 1 } }, { session });
      if (!changed(result)) fail(409, FAMILY_CLOSE_CONFLICT);
      return callback(session, { ...family, lifecycleRev: (family.lifecycleRev || 0) + 1 });
    });
  }

  async function beginClose(owner, exactFamilyIds) {
    if (!validId(owner)) fail(400, 'INVALID_OWNER');
    if (!Array.isArray(exactFamilyIds) || exactFamilyIds.some(id => !validId(id))) {
      fail(400, 'INVALID_FAMILY_CONFIRMATION');
    }
    const requested = sortedIds(exactFamilyIds);
    const closeOperationId = operationId();
    if (!validId(String(closeOperationId))) fail(500, 'INVALID_CLOSE_OPERATION_ID');
    const closedAt = now();

    // The exact owner-family set is checked inside the transaction, but a
    // snapshot does not fence a concurrent insert of a new family document.
    // Callers must put createFamily/account lifecycle writes behind the same
    // account-level boundary before claiming full account closure.
    return transaction(async session => {
      const families = await familyCollection.find({ owner }, {
        session,
        projection: { _id: 1, owner: 1, closure: 1, lifecycleRev: 1 }
      }).toArray();
      const actual = sortedIds(families.map(family => family._id));
      if (!requested.length || !sameIdSet(requested, actual) || new Set(exactFamilyIds.map(String)).size !== exactFamilyIds.length) {
        fail(409, FAMILY_CLOSE_CONFIRMATION_REQUIRED, {
          owner,
          familyIds: actual
        });
      }

      const profiles = actual.length ? await profileCollection.find({ familyId: { $in: actual } }, {
        session,
        projection: { _id: 1, familyId: 1, members: 1 }
      }).toArray() : [];
      const members = profiles.filter(profile => {
        const values = Array.isArray(profile.members) ? [...new Set(profile.members.map(String))] : [];
        return values.length !== 1 || values[0] !== owner;
      });
      if (members.length) {
        fail(409, FAMILY_TRANSFER_REQUIRED, {
          owner,
          families: actual,
          profiles: members.map(profile => ({ profileId: profile._id, familyId: profile.familyId }))
        });
      }

      for (const family of families) {
        assertOpen(family);
        const result = await familyCollection.updateOne({
          _id: family._id,
          owner,
          $or: [
            { closure: { $exists: false } },
            { 'closure.status': 'open' }
          ]
        }, {
          $set: {
            closure: { status: 'closing', operationId: String(closeOperationId), owner, at: closedAt }
          },
          $inc: { lifecycleRev: 1 }
        }, { session });
        if (!changed(result)) fail(409, FAMILY_CLOSE_CONFLICT);
      }
      return {
        status: 'closing',
        owner,
        familyIds: actual,
        operationId: String(closeOperationId),
        at: closedAt
      };
    });
  }

  return { withOpenFamily, beginClose };
}

module.exports = {
  FAMILY_ACCESS_DENIED,
  FAMILY_CLOSED,
  FAMILY_CLOSING,
  FAMILY_CLOSE_CONFLICT,
  FAMILY_CLOSE_CONFIRMATION_REQUIRED,
  FAMILY_TRANSFER_REQUIRED,
  TRANSACTION_OPTIONS,
  createCareFamilyLifecycle
};

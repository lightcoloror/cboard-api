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
const ACCOUNT_CLOSED = 'ACCOUNT_CLOSED';
const ACCOUNT_CLOSING = 'ACCOUNT_CLOSING';
const ACCOUNT_CLOSE_CONFLICT = 'ACCOUNT_CLOSE_CONFLICT';

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
  Communicator = null,
  AccountLifecycle = null,
  now = () => Date.now(),
  operationId = () => crypto.randomBytes(16).toString('hex')
} = {}) {
  const familyCollection = modelCollection(Family, 'Family');
  const profileCollection = modelCollection(Profile, 'Profile');
  const accountLifecycleCollection = modelCollection(
    AccountLifecycle || { collection: connection.collection('careaccountlifecycles') },
    'AccountLifecycle'
  );
  let communicatorCollection = Communicator ? modelCollection(Communicator, 'Communicator') : null;
  function getCommunicatorCollection() {
    if (!communicatorCollection) {
      communicatorCollection = modelCollection({ collection: connection.collection('communicators') }, 'Communicator');
    }
    return communicatorCollection;
  }

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

  function accountStatus(account) {
    return account && account.status || 'open';
  }

  function assertAccountOpen(account) {
    if (!account) return;
    if (accountStatus(account) === 'closed') fail(403, ACCOUNT_CLOSED);
    if (accountStatus(account) === 'closing') fail(409, ACCOUNT_CLOSING);
    if (accountStatus(account) !== 'open') fail(409, ACCOUNT_CLOSE_CONFLICT);
  }

  async function lockOpenAccount(owner, session) {
    let account = await accountLifecycleCollection.findOne({ _id: owner }, { session });
    assertAccountOpen(account);
    if (!account) {
      // A duplicate first-writer insert aborts the transaction. There is no
      // independent-write fallback that could bypass a concurrent close.
      try {
        await accountLifecycleCollection.insertOne({ _id: owner, status: 'open', lifecycleRev: 0 }, { session });
      } catch (error) {
        if (error.code === 11000) fail(409, ACCOUNT_CLOSE_CONFLICT);
        throw error;
      }
      account = { _id: owner, status: 'open', lifecycleRev: 0 };
    }
    const result = await accountLifecycleCollection.updateOne({
      _id: owner,
      $or: [
        { status: { $exists: false } },
        { status: 'open' }
      ]
    }, { $inc: { lifecycleRev: 1 } }, { session });
    if (!changed(result)) fail(409, ACCOUNT_CLOSE_CONFLICT);
    return { ...account, lifecycleRev: (account.lifecycleRev || 0) + 1 };
  }

  async function withOpenAccount(owner, callback) {
    if (!validId(owner)) fail(400, 'INVALID_OWNER');
    if (typeof callback !== 'function') fail(400, 'INVALID_ACCOUNT_CALLBACK');
    return transaction(async session => {
      const account = await lockOpenAccount(owner, session);
      // withTransaction can retry this callback. Keep it limited to Mongo
      // operations; external I/O must happen after the committed result.
      return callback(session, account);
    });
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

    // createFamily and beginClose serialize through the same account document.
    // Direct inserts and ownership transfers that bypass this boundary remain
    // unsafe; all such writers must be integrated before enabling HTTP closure.
    return transaction(async session => {
      const account = await lockOpenAccount(owner, session);
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
      const accountResult = await accountLifecycleCollection.updateOne({
        _id: owner,
        $or: [
          { status: { $exists: false } },
          { status: 'open' }
        ]
      }, {
        $set: {
          status: 'closing',
          closure: { status: 'closing', operationId: String(closeOperationId), owner, familyIds: actual, at: closedAt }
        },
        $inc: { lifecycleRev: 1 }
      }, { session });
      if (!changed(accountResult)) fail(409, ACCOUNT_CLOSE_CONFLICT);
      return {
        status: 'closing',
        owner,
        familyIds: actual,
        operationId: String(closeOperationId),
        at: closedAt
      };
    });
  }

  async function createFamily(value) {
    if (!value || !validId(value._id) || !validId(value.owner)) fail(400, 'INVALID_FAMILY');
    return withOpenAccount(value.owner, async session => {
      await familyCollection.insertOne(value, { session });
      return value;
    });
  }

  async function casFamily(id, rev, value) {
    if (!validId(id) || !Number.isSafeInteger(rev) || rev < 0 || !value ||
      Object.keys(value).some(key => !['owner', 'rev', 'sealed'].includes(key)) ||
      value.rev !== rev + 1 || (value.owner !== undefined && !validId(value.owner))) {
      fail(400, 'INVALID_FAMILY_UPDATE');
    }
    return transaction(async session => {
      const family = await readFamily(id, session);
      if ((family.rev || 0) !== rev) return false;
      if (!validId(family.owner)) fail(409, FAMILY_CLOSE_CONFLICT);
      // Both ownership directions share the account-close fence. Sorting gives
      // simultaneous transfers a consistent lock order; all writes stay atomic.
      const owners = [...new Set([family.owner, value.owner || family.owner])].sort();
      for (const owner of owners) await lockOpenAccount(owner, session);
      const version = rev === 0 ? { $or: [{ rev: 0 }, { rev: { $exists: false } }] } : { rev };
      const result = await familyCollection.updateOne({
        _id: id, owner: family.owner,
        $and: [version, { $or: [{ closure: { $exists: false } }, { 'closure.status': 'open' }] }]
      }, { $set: value, $inc: { lifecycleRev: 1 } }, { session });
      if (!changed(result)) fail(409, FAMILY_CLOSE_CONFLICT);
      return true;
    });
  }

  async function casProfile(id, rev, value, context = {}) {
    if (!validId(id) || !Number.isSafeInteger(rev) || rev < 0 || !value ||
      Object.keys(value).some(key => !['sealed', 'rev', 'members'].includes(key)) ||
      value.rev !== rev + 1 || !Array.isArray(value.members) ||
      value.members.some(member => !validId(member)) ||
      (context.expectedOwner !== undefined && !validId(context.expectedOwner))) {
      fail(400, 'INVALID_PROFILE_UPDATE');
    }
    return transaction(async session => {
      const profile = await profileCollection.findOne({ _id: id }, { session });
      if (!profile) fail(403, 'PROFILE_ACCESS_DENIED');
      if ((profile.rev || 0) !== rev) return false;
      const family = await readFamily(profile.familyId, session);
      if (!validId(family.owner)) fail(409, FAMILY_CLOSE_CONFLICT);
      if (context.expectedOwner !== undefined && family.owner !== context.expectedOwner) return false;
      await lockOpenAccount(family.owner, session);
      const familyResult = await familyCollection.updateOne({
        _id: profile.familyId,
        owner: family.owner,
        $or: [
          { closure: { $exists: false } },
          { 'closure.status': 'open' }
        ]
      }, { $inc: { lifecycleRev: 1 } }, { session });
      if (!changed(familyResult)) fail(409, FAMILY_CLOSE_CONFLICT);
      const version = rev === 0 ? { $or: [{ rev: 0 }, { rev: { $exists: false } }] } : { rev };
      const result = await profileCollection.updateOne({
        _id: id,
        familyId: profile.familyId,
        $and: [version]
      }, { $set: value, $inc: { lifecycleRev: 1 } }, { session });
      if (!changed(result)) fail(409, FAMILY_CLOSE_CONFLICT);
      return true;
    });
  }

  async function createProfile(value, communicator) {
    if (!value || !validId(value._id) || !validId(value.familyId) || !validId(value.owner) ||
      value.rev !== 0 || !Array.isArray(value.members) || value.members.some(member => !validId(member)) ||
      !communicator || communicator.careProfileId !== value._id || communicator.careFamilyId !== value.familyId) {
      fail(400, 'INVALID_PROFILE');
    }
    return transaction(async session => {
      const family = await readFamily(value.familyId, session);
      if (family.owner !== value.owner) fail(403, FAMILY_ACCESS_DENIED);
      await lockOpenAccount(value.owner, session);
      const familyResult = await familyCollection.updateOne({
        _id: value.familyId,
        owner: value.owner,
        $or: [
          { closure: { $exists: false } },
          { 'closure.status': 'open' }
        ]
      }, { $inc: { lifecycleRev: 1 } }, { session });
      if (!changed(familyResult)) fail(409, FAMILY_CLOSE_CONFLICT);
      await getCommunicatorCollection().insertOne(communicator, { session });
      await profileCollection.insertOne(value, { session });
      return value;
    });
  }

  return { withOpenFamily, withOpenAccount, beginClose, createFamily, casFamily, casProfile, createProfile };
}

module.exports = {
  FAMILY_ACCESS_DENIED,
  FAMILY_CLOSED,
  FAMILY_CLOSING,
  FAMILY_CLOSE_CONFLICT,
  FAMILY_CLOSE_CONFIRMATION_REQUIRED,
  FAMILY_TRANSFER_REQUIRED,
  ACCOUNT_CLOSED,
  ACCOUNT_CLOSING,
  ACCOUNT_CLOSE_CONFLICT,
  TRANSACTION_OPTIONS,
  createCareFamilyLifecycle
};

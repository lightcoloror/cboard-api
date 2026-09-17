'use strict';
const { Family, Profile, Account } = require('../models/CareWorkspace');
const mongoose = require('mongoose');
const blob = require('./blob');
const { createCareService } = require('./careService');
const {
  createCareMediaQuota,
  resolveCareMediaQuotaConfig
} = require('./careMediaQuota');
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const communicatorRecord = (id, familyId) => ({
  careProfileId: id, careFamilyId: familyId, name: '共享沟通档案', author: 'care-service',
  email: `care-${id}@invalid.local`, rootBoard: '', boards: []
});
async function withAccountWrite(owner, context, callback) {
  const lifecycle = require('./careFamilyLifecycle').createCareFamilyLifecycle();
  if (!context || !['favorite', 'select-profile'].includes(context.mode)) return lifecycle.withOpenAccount(owner, callback);
  if (context.mode === 'select-profile') {
    const profileId = context.profileId;
    if (!validId(owner) || !validId(profileId)) throw Object.assign(new Error('PROFILE_ACCESS_DENIED'), { status: 403, code: 'PROFILE_ACCESS_DENIED' });
    const initial = await Profile.findById(profileId).lean().exec();
    if (!initial) throw Object.assign(new Error('PROFILE_ACCESS_DENIED'), { status: 403, code: 'PROFILE_ACCESS_DENIED' });
    return lifecycle.withOpenFamilyAccounts(initial.familyId, [owner], async (session, family) => {
      const profile = await Profile.collection.findOne({ _id: profileId }, { session });
      if (!profile || profile.familyId !== initial.familyId) throw Object.assign(new Error('PROFILE_ACCESS_DENIED'), { status: 403, code: 'PROFILE_ACCESS_DENIED' });
      const state = require('./careCrypto').fromEnvironment().open(profile.sealed, `profile:${profileId}`);
      if (state.deleted || owner !== family.owner && !((state.grants || {})[owner] || []).includes('read')) throw Object.assign(new Error('PROFILE_ACCESS_DENIED'), { status: 403, code: 'PROFILE_ACCESS_DENIED' });
      return callback(session);
    });
  }
  const { actor, profileId, resourceId, sharedId, sharedVersion } = context;
  if (!validId(owner) || !validId(actor) || !validId(profileId) || !validId(resourceId) ||
      (sharedId !== undefined && (!validId(sharedId) || !Number.isSafeInteger(sharedVersion) || sharedVersion < 1))) {
    throw Object.assign(new Error('FAVORITE_SCOPE_DENIED'), { status: 403, code: 'FAVORITE_SCOPE_DENIED' });
  }
  const initial = await Profile.findById(profileId).lean().exec();
  if (!initial) throw Object.assign(new Error('FAVORITE_SCOPE_DENIED'), { status: 403, code: 'FAVORITE_SCOPE_DENIED' });
  return lifecycle.withOpenFamilyAccounts(initial.familyId, [owner, actor], async (session, family) => {
    const profile = await Profile.collection.findOne({ _id: profileId }, { session });
    if (!profile || profile.familyId !== initial.familyId) throw Object.assign(new Error('FAVORITE_SCOPE_DENIED'), { status: 403, code: 'FAVORITE_SCOPE_DENIED' });
    const crypto = require('./careCrypto').fromEnvironment();
    const state = crypto.open(profile.sealed, `profile:${profileId}`);
    if (state.deleted) throw Object.assign(new Error('FAVORITE_SCOPE_DENIED'), { status: 403, code: 'FAVORITE_SCOPE_DENIED' });
    if (actor !== family.owner && !((state.grants || {})[actor] || []).includes('read')) throw Object.assign(new Error('FAVORITE_SCOPE_DENIED'), { status: 403, code: 'FAVORITE_SCOPE_DENIED' });
    if (process.env.CARE_NEXT_ENABLED === 'true') {
      const familyState = crypto.open(family.sealed, `family:${initial.familyId}`);
      if (!require('./carePolicy').entitlement(familyState.subscription, Date.now()).syncWrite) throw Object.assign(new Error('SUBSCRIPTION_EXPIRED'), { status: 403, code: 'SUBSCRIPTION_EXPIRED' });
    }
    if (sharedId !== undefined) {
      if (actor !== family.owner) throw Object.assign(new Error('FAVORITE_SCOPE_DENIED'), { status: 403, code: 'FAVORITE_SCOPE_DENIED' });
      const shared = state.resources && state.resources[`favorite:${sharedId}`];
      if (!shared || !shared.source || shared.source.owner !== owner || shared.source.id !== resourceId) throw Object.assign(new Error('FAVORITE_SCOPE_DENIED'), { status: 403, code: 'FAVORITE_SCOPE_DENIED' });
      if (shared.version !== sharedVersion) throw Object.assign(new Error('SHARED_FAVORITE_CHANGED'), { status: 409, code: 'SHARED_FAVORITE_CHANGED' });
    } else if (owner !== actor) {
      throw Object.assign(new Error('FAVORITE_SCOPE_DENIED'), { status: 403, code: 'FAVORITE_SCOPE_DENIED' });
    }
    return callback(session);
  });
}
const store = {
  createFamily: value => process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true'
    ? require('./careFamilyLifecycle').createCareFamilyLifecycle().createFamily(value)
    : Family.create(value),
  getFamily: id => Family.findById(id).lean().exec(),
  casFamily: async (id, rev, value) => {
    if (process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true') {
      return require('./careFamilyLifecycle').createCareFamilyLifecycle().casFamily(id, rev, value);
    }
    const filter = rev === 0 ? { _id: id, $or: [{ rev: 0 }, { rev: { $exists: false } }] } : { _id: id, rev };
    const result = await Family.updateOne(filter, { $set: value }).exec();
    return (result.nModified || result.modifiedCount) === 1;
  },
  listFamilies: owner => Family.find({ owner }).lean().exec(),
  getAccount: id => Account.findById(id).lean().exec(),
  createAccount: async (value, context = {}) => {
    if (process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true') {
      try {
        return await withAccountWrite(value._id, context, async session => {
          await Account.collection.insertOne(value, { session });
          return true;
        });
      } catch (e) { if (e.code === 11000) return false; throw e; }
    }
    try { await Account.create(value); return true; } catch (e) { if (e.code === 11000) return false; throw e; }
  },
  casAccount: async (id, rev, value, context = {}) => {
    if (process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true') {
      return withAccountWrite(id, context, async session => {
        const result = await Account.collection.updateOne({ _id: id, rev }, { $set: value }, { session });
        return (result.matchedCount !== undefined ? result.matchedCount : result.n) === 1;
      });
    }
    const result = await Account.updateOne({ _id: id, rev }, { $set: value }).exec();
    return (result.nModified || result.modifiedCount) === 1;
  },
  createProfile: value => Profile.create(value),
  createProfileWithCommunicator: async value => {
    if (process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true') {
      return require('./careFamilyLifecycle').createCareFamilyLifecycle().createProfile(value,
        communicatorRecord(value._id, value.familyId));
    }
    await store.createCommunicator(value._id, value.familyId);
    return store.createProfile(value);
  },
  getProfile: id => Profile.findById(id).lean().exec(),
  listProfiles: async user => {
    const owned = await Family.find({ owner: user }).select('_id').lean().exec();
    return Profile.find({ $or: [{ members: user }, { familyId: { $in: owned.map(f => f._id) } }] }).lean().exec();
  },
  listProfilesByFamily: familyId => Profile.find({ familyId }).lean().exec(),
  casProfile: async (id, rev, value, context) => {
    if (process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true') {
      return require('./careFamilyLifecycle').createCareFamilyLifecycle().casProfile(id, rev, value, context);
    }
    const result = await Profile.updateOne({ _id: id, rev }, { $set: value }).exec();
    return (result.nModified || result.modifiedCount) === 1;
  },
  createCommunicator: (id, familyId) => mongoose.connection.collection('communicators').insertOne(communicatorRecord(id, familyId))
};
const container = () => process.env.CARE_MEDIA_CONTAINER || 'cboard-care-private';
const media = {
  async write(buffer) {
    if (!blob.isBlobStorageConfigured()) { const e = new Error('Storage unavailable'); e.status = 503; throw e; }
    const [file] = await blob.createBlockBlobFromText(container(), 'care.bin',
      { buffer, mimetype: 'application/octet-stream' }, 'care', { cacheControl: 'no-store' }, { publicAccessLevel: null });
    return file.name;
  },
  read: name => blob.getBlobToBuffer(container(), name),
  remove: name => blob.deleteBlobIfExists(container(), name)
};
const getMediaAdapter = () => process.env.CARE_MEDIA_ROOT
  ? require('./careFileMedia').createCareFileMedia(process.env.CARE_MEDIA_ROOT) : media;
exports.getMediaAdapter = getMediaAdapter;
exports.createRuntime = () => {
  const encryption = require('./careCrypto').fromEnvironment();
  return createCareService({ store,
    enforceEntitlements: process.env.CARE_NEXT_ENABLED === 'true',
    media: getMediaAdapter(),
    mediaQuota: createCareMediaQuota({
      store,
      encryption,
      config: resolveCareMediaQuotaConfig(process.env)
    }),
    encryption });
};
exports.store = store;

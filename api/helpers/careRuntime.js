'use strict';
const { Family, Profile, Account } = require('../models/CareWorkspace');
const mongoose = require('mongoose');
const blob = require('./blob');
const { createCareService } = require('./careService');
const {
  createCareMediaQuota,
  resolveCareMediaQuotaConfig
} = require('./careMediaQuota');
const communicatorRecord = (id, familyId) => ({
  careProfileId: id, careFamilyId: familyId, name: '共享沟通档案', author: 'care-service',
  email: `care-${id}@invalid.local`, rootBoard: '', boards: []
});
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
  createAccount: async value => {
    if (process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true') {
      try {
        return await require('./careFamilyLifecycle').createCareFamilyLifecycle().withOpenAccount(value._id, async session => {
          await Account.collection.insertOne(value, { session });
          return true;
        });
      } catch (e) { if (e.code === 11000) return false; throw e; }
    }
    try { await Account.create(value); return true; } catch (e) { if (e.code === 11000) return false; throw e; }
  },
  casAccount: async (id, rev, value) => {
    if (process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true') {
      return require('./careFamilyLifecycle').createCareFamilyLifecycle().withOpenAccount(id, async session => {
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
exports.createRuntime = () => {
  const encryption = require('./careCrypto').fromEnvironment();
  return createCareService({ store,
    enforceEntitlements: process.env.CARE_NEXT_ENABLED === 'true',
    media: process.env.CARE_MEDIA_ROOT ? require('./careFileMedia').createCareFileMedia(process.env.CARE_MEDIA_ROOT) : media,
    mediaQuota: createCareMediaQuota({
      store,
      encryption,
      config: resolveCareMediaQuotaConfig(process.env)
    }),
    encryption });
};
exports.store = store;

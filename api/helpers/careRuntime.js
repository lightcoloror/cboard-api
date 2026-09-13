'use strict';
const { Family, Profile, Account } = require('../models/CareWorkspace');
const mongoose = require('mongoose');
const blob = require('./blob');
const { createCareService } = require('./careService');
const store = {
  createFamily: value => Family.create(value),
  getFamily: id => Family.findById(id).lean().exec(),
  casFamily: async (id, rev, value) => {
    const filter = rev === 0 ? { _id: id, $or: [{ rev: 0 }, { rev: { $exists: false } }] } : { _id: id, rev };
    const result = await Family.updateOne(filter, { $set: value }).exec();
    return (result.nModified || result.modifiedCount) === 1;
  },
  listFamilies: owner => Family.find({ owner }).lean().exec(),
  getAccount: id => Account.findById(id).lean().exec(),
  createAccount: async value => { try { await Account.create(value); return true; } catch (e) { if (e.code === 11000) return false; throw e; } },
  casAccount: async (id, rev, value) => {
    const result = await Account.updateOne({ _id: id, rev }, { $set: value }).exec();
    return (result.nModified || result.modifiedCount) === 1;
  },
  createProfile: value => Profile.create(value),
  getProfile: id => Profile.findById(id).lean().exec(),
  listProfiles: async user => {
    const owned = await Family.find({ owner: user }).select('_id').lean().exec();
    return Profile.find({ $or: [{ members: user }, { familyId: { $in: owned.map(f => f._id) } }] }).lean().exec();
  },
  casProfile: async (id, rev, value) => {
    const result = await Profile.updateOne({ _id: id, rev }, { $set: value }).exec();
    return (result.nModified || result.modifiedCount) === 1;
  },
  createCommunicator: (id, familyId) => mongoose.connection.collection('communicators').insertOne({
    careProfileId: id, careFamilyId: familyId, name: '共享沟通档案', author: 'care-service',
    email: `care-${id}@invalid.local`, rootBoard: '', boards: []
  })
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
exports.createRuntime = () => createCareService({ store,
  enforceEntitlements: process.env.CARE_NEXT_ENABLED === 'true',
  media: process.env.CARE_MEDIA_ROOT ? require('./careFileMedia').createCareFileMedia(process.env.CARE_MEDIA_ROOT) : media,
  encryption: require('./careCrypto').fromEnvironment() });
exports.store = store;

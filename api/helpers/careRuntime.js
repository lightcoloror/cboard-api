'use strict';
const { Family, Profile } = require('../models/CareWorkspace');
const mongoose = require('mongoose');
const blob = require('./blob');
const { createCareService } = require('./careService');
const store = {
  createFamily: value => Family.create(value),
  getFamily: id => Family.findById(id).lean().exec(),
  listFamilies: owner => Family.find({ owner }).lean().exec(),
  createProfile: value => Profile.create(value),
  getProfile: id => Profile.findById(id).lean().exec(),
  listProfiles: user => Profile.find({ members: user }).lean().exec(),
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
  media: process.env.CARE_MEDIA_ROOT ? require('./careFileMedia').createCareFileMedia(process.env.CARE_MEDIA_ROOT) : media,
  encryption: require('./careCrypto').fromEnvironment() });

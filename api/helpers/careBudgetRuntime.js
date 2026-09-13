'use strict';
const mongoose = require('mongoose');
const { createCareBudget } = require('./careBudget');
const { fail } = require('./carePolicy');
const Funding = mongoose.models.CareFunding || mongoose.model('CareFunding', new mongoose.Schema({
  _id: String, rev: Number, kind: String, owner: String, familyId: String,
  members: { type: [String], index: true }, sealed: Object
}, { minimize: false }));
const store = {
  get: id => Funding.findById(id).lean().exec(),
  create: async value => { try { await Funding.create(value); return true; } catch (e) { if (e.code === 11000) return false; throw e; } },
  cas: async (id, rev, value) => {
    const result = await Funding.updateOne({ _id: id, rev }, { $set: value }).exec();
    return (result.nModified || result.modifiedCount) === 1;
  }
};
function createRuntime() {
  return createCareBudget({ store, encryption: require('./careCrypto').fromEnvironment() });
}
async function authorizeProfile(user, profileId, fundingId, requireActive = false) {
  const profiles = await require('./careRuntime').createRuntime().profiles(user);
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) fail(403, 'PROFILE_ACCESS_DENIED');
  if (requireActive && !(await require('./careRuntime').createRuntime().entitlements(user, profileId)).ai) fail(403, 'SUBSCRIPTION_EXPIRED');
  const funding = await store.get(fundingId);
  if (!funding || (funding.kind === 'family' && funding.familyId !== profile.familyId)) fail(403, 'FUNDING_ACCESS_DENIED');
  return profile;
}
module.exports = { Funding, store, createRuntime, authorizeProfile };

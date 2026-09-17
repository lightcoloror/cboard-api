'use strict';
const mongoose = require('mongoose');
const { createCareBudget } = require('./careBudget');
const { fail } = require('./carePolicy');
const { Profile } = require('../models/CareWorkspace');
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const Funding = mongoose.models.CareFunding || mongoose.model('CareFunding', new mongoose.Schema({
  _id: String, rev: Number, kind: String, owner: String, familyId: String,
  members: { type: [String], index: true }, sealed: Object
}, { minimize: false }));
const store = {
  get: id => Funding.findById(id).lean().exec(),
  create: async value => {
    if (process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true') {
      try {
        return await require('./careFamilyLifecycle').createCareFamilyLifecycle().withOpenFamilyAccounts(
          value.kind === 'family' ? value.familyId : null, [value.owner], async session => {
            await Funding.collection.insertOne(value, { session });
            return true;
          });
      } catch (e) { if (e.code === 11000) return false; throw e; }
    }
    try { await Funding.create(value); return true; } catch (e) { if (e.code === 11000) return false; throw e; }
  },
  cas: async (id, rev, value, context = {}) => {
    if (process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED !== 'true' || context.mode === 'settle') {
      const result = await Funding.updateOne({ _id: id, rev }, { $set: value }).exec();
      return (result.nModified || result.modifiedCount) === 1;
    }

    const current = await Funding.findById(id).lean().exec();
    if (!current || current.rev !== rev) return false;
    const profileId = context.profileId;
    const actor = context.actor;
    if (context.mode === 'reserve' && (!validId(profileId) || !validId(actor))) fail(403, 'FUNDING_ACCESS_DENIED');
    let familyId = current.kind === 'family' ? current.familyId : null;
    let initialProfile = null;
    if (context.mode === 'reserve') {
      initialProfile = await Profile.findById(profileId).lean().exec();
      if (!initialProfile) fail(403, 'FUNDING_ACCESS_DENIED');
      if (current.kind === 'family' && initialProfile.familyId !== familyId) fail(403, 'FUNDING_ACCESS_DENIED');
      if (current.kind !== 'family') familyId = initialProfile.familyId;
    }
    const accountIds = [current.owner, ...(actor ? [actor] : [])];
    return require('./careFamilyLifecycle').createCareFamilyLifecycle().withOpenFamilyAccounts(familyId, accountIds,
      async (session, family) => {
        if (context.mode === 'delegate' && family && actor !== family.owner) fail(403, 'FUNDING_ADMIN_REQUIRED');
        if (context.mode === 'reserve') {
          const profile = await Profile.collection.findOne({ _id: profileId }, { session });
          if (!profile || profile.familyId !== familyId || (initialProfile && profile.familyId !== initialProfile.familyId)) fail(403, 'FUNDING_ACCESS_DENIED');
          const profileState = require('./careCrypto').fromEnvironment().open(profile.sealed, `profile:${profileId}`);
          if (profileState.deleted) fail(403, 'PROFILE_ACCESS_DENIED');
          if (!family || actor !== family.owner && !(profileState.grants[actor] || []).includes('read')) fail(403, 'FUNDING_ACCESS_DENIED');
          const familyState = require('./careCrypto').fromEnvironment().open(family.sealed, `family:${familyId}`);
          if (!require('./carePolicy').entitlement(familyState.subscription, Date.now()).ai) fail(403, 'SUBSCRIPTION_EXPIRED');
        }
        const result = await Funding.collection.updateOne({ _id: id, rev }, { $set: value }, { session });
        return (result.matchedCount !== undefined ? result.matchedCount : result.n) === 1;
      });
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
  if (requireActive) {
    const state = require('./careCrypto').fromEnvironment().open(funding.sealed, `funding:${fundingId}`);
    if (state.trialPending) fail(403, 'TRIAL_PENDING_ACTIVATION');
  }
  return profile;
}
module.exports = { Funding, store, createRuntime, authorizeProfile };

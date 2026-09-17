'use strict';

const PLAN_VERSION = 1;
const MAX_PLAN_BYTES = 5 * 1024 * 1024;

function unavailable() {
  throw Object.assign(new Error('CLOSURE_PLAN_UNAVAILABLE'), { status: 503, code: 'CLOSURE_PLAN_UNAVAILABLE' });
}

function failTooLarge() {
  throw Object.assign(new Error('CLOSURE_PLAN_TOO_LARGE'), { status: 503, code: 'CLOSURE_PLAN_TOO_LARGE' });
}

function stringId(value) {
  return typeof value === 'string' && value.length > 0;
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function open(encryption, sealed, context) {
  if (!encryption || typeof encryption.open !== 'function') unavailable();
  try {
    const state = encryption.open(sealed, context);
    if (!record(state)) unavailable();
    return state;
  } catch (_) { unavailable(); }
}

function exactIds(expected, docs, field) {
  if (!Array.isArray(expected) || new Set(expected).size !== expected.length || expected.some(id => !stringId(id))) unavailable();
  if (!Array.isArray(docs)) unavailable();
  const actual = docs.map(doc => doc && doc[field]);
  if (actual.some(id => !stringId(id)) || new Set(actual).size !== actual.length || actual.length !== expected.length ||
      actual.some(id => !expected.includes(id))) unavailable();
  return new Set(expected);
}

function buildCareClosurePlan({ owner, familyIds, families, profiles, fundings, accounts = [], encryption }) {
  if (!stringId(owner)) unavailable();
  const familySet = exactIds(familyIds, families, '_id');
  for (const family of families) if (family.owner !== owner) unavailable();
  if (!Array.isArray(profiles) || profiles.some(profile => !profile || !stringId(profile._id) || !familySet.has(profile.familyId))) unavailable();
  const profileIds = profiles.map(profile => profile._id);
  if (new Set(profileIds).size !== profileIds.length) unavailable();
  const profileSet = new Set(profileIds);
  if (!Array.isArray(accounts)) unavailable();
  const relatedAccounts = new Set([owner]);
  for (const account of accounts) {
    if (!account || !stringId(account._id)) unavailable();
    const state = open(encryption, account.sealed, `account:${account._id}`);
    if (!state || typeof state !== 'object') unavailable();
    const favorites = state.favorites;
    if (favorites !== undefined && (!favorites || typeof favorites !== 'object' || Array.isArray(favorites))) unavailable();
    for (const favorite of Object.values(favorites || {})) if (favorite && profileSet.has(favorite.profileId)) relatedAccounts.add(account._id);
    if (state.favoriteAudit !== undefined && !Array.isArray(state.favoriteAudit)) unavailable();
    for (const item of state.favoriteAudit || []) if (item && profileSet.has(item.profileId)) relatedAccounts.add(account._id);
    const receipts = state.favoriteReceipts;
    if (receipts !== undefined && (!receipts || typeof receipts !== 'object' || Array.isArray(receipts))) unavailable();
    for (const receipt of Object.values(receipts || {})) {
      if (receipt && receipt.result && receipt.result.resource && profileSet.has(receipt.result.resource.profileId)) relatedAccounts.add(account._id);
    }
  }
  const media = [];
  for (const profile of profiles) {
    const state = open(encryption, profile.sealed, `profile:${profile._id}`);
    if (state.media !== undefined && !record(state.media)) unavailable();
    for (const [mediaId, entry] of Object.entries(state.media || {})) {
      if (entry && entry.deleted === true && entry.storageReleased === true) continue;
      if (!entry || typeof entry.blob !== 'string' || !entry.blob) unavailable();
      media.push({ familyId: profile.familyId, profileId: profile._id, mediaId, blob: entry.blob });
    }
  }

  const pendingUploads = [];
  for (const family of families) {
    const state = open(encryption, family.sealed, `family:${family._id}`);
    const quota = state.mediaQuota;
    if (quota === undefined) continue;
    if (!record(quota)) unavailable();
    if (!quota.reservations || typeof quota.reservations !== 'object' || Array.isArray(quota.reservations)) unavailable();
    for (const [key, reservation] of Object.entries(quota.reservations)) {
      if (!record(reservation) || !['reserved', 'committed', 'released'].includes(reservation.status)) unavailable();
      if (reservation.status !== 'reserved') continue;
      if (!stringId(reservation.profileId) || !stringId(reservation.mediaId)) unavailable();
      if (reservation.objectName !== undefined && reservation.objectName !== null && !stringId(reservation.objectName)) unavailable();
      pendingUploads.push({ familyId: family._id, key, profileId: reservation.profileId, mediaId: reservation.mediaId, objectName: reservation.objectName || null });
    }
  }

  const familyFundingIds = [];
  const pendingUsage = [];
  const institutionAdminIds = [];
  if (!Array.isArray(fundings)) unavailable();
  for (const funding of fundings) {
    if (!funding || !stringId(funding._id) || !stringId(funding.kind) || !stringId(funding.owner)) unavailable();
    const closedFamilyFunding = funding.kind === 'family' && familySet.has(funding.familyId);
    if (funding.kind === 'family' && closedFamilyFunding) familyFundingIds.push(funding._id);
    if (funding.kind === 'institution' && funding.owner === owner) institutionAdminIds.push(funding._id);
    const state = open(encryption, funding.sealed, `funding:${funding._id}`);
    if (!state || !state.receipts || typeof state.receipts !== 'object' || Array.isArray(state.receipts)) unavailable();
    for (const receipt of Object.values(state.receipts)) {
      if (!record(receipt) || !['reserved', 'settled', 'released'].includes(receipt.status)) unavailable();
      if (receipt.status !== 'reserved') continue;
      if (!stringId(receipt.actor) || !stringId(receipt.requestId) || !stringId(receipt.profileId)) unavailable();
      if (closedFamilyFunding || receipt.actor === owner || profileSet.has(receipt.profileId)) {
        pendingUsage.push({ fundingId: funding._id, actor: receipt.actor, requestId: receipt.requestId, profileId: receipt.profileId });
      }
    }
  }

  const plan = {
    version: PLAN_VERSION,
    owner,
    familyIds: [...familySet].sort(),
    profileIds: [...profileSet].sort(),
    familyFundingIds: [...new Set(familyFundingIds)].sort(),
    media,
    pendingUploads,
    pendingUsage,
    institutionAdminIds: [...new Set(institutionAdminIds)].sort(),
    relatedAccountIds: [...relatedAccounts].sort()
  };
  if (Buffer.byteLength(JSON.stringify(plan), 'utf8') > MAX_PLAN_BYTES) failTooLarge();
  return plan;
}

module.exports = { MAX_PLAN_BYTES, buildCareClosurePlan };

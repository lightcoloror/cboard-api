'use strict';

const crypto = require('crypto');

const QUOTA_VERSION = 1;
const MAX_QUOTA_STATE_BYTES = 512 * 1024;

function fail(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  throw error;
}

function boundedPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveCareMediaQuotaConfig(env = process.env) {
  const limitBytes = boundedPositiveInteger(env.CARE_FAMILY_MEDIA_QUOTA_BYTES);
  const maxFiles = boundedPositiveInteger(env.CARE_FAMILY_MEDIA_QUOTA_MAX_FILES);
  return Object.freeze({ available: Boolean(limitBytes && maxFiles), limitBytes, maxFiles });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validMediaSize(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function reservationKey({ profileId, mediaId, sha256 }) {
  return crypto
    .createHash('sha256')
    .update(`care-media:${profileId}:${mediaId}:${sha256}`)
    .digest('hex');
}

function releasedKey({ profileId, mediaId, sha256 }) {
  return crypto
    .createHash('sha256')
    .update(`care-media-release:${profileId}:${mediaId}:${sha256}`)
    .digest('hex');
}

function objectName() {
  return `${crypto.randomBytes(24).toString('hex')}.bin`;
}

function validObjectName(value) {
  return /^[a-f0-9]{48}\.bin$/.test(value || '');
}

function calculateExistingUsage(profiles, encryption) {
  let usedBytes = 0;
  let usedFiles = 0;
  for (const profile of profiles) {
    let state;
    try {
      state = encryption.open(profile.sealed, `profile:${profile._id}`);
    } catch (_) {
      fail(503, 'MEDIA_QUOTA_RECONCILIATION_REQUIRED');
    }
    for (const media of Object.values((state && state.media) || {})) {
      // A tombstone only stops counting after this implementation has recorded
      // successful physical removal. Older tombstones remain conservative.
      if (media && media.deleted && media.storageReleased === true) continue;
      if (!media || !validMediaSize(media.size)) {
        fail(503, 'MEDIA_QUOTA_RECONCILIATION_REQUIRED');
      }
      usedBytes += media.size;
      usedFiles += 1;
      if (!Number.isSafeInteger(usedBytes) || !Number.isSafeInteger(usedFiles)) {
        fail(503, 'MEDIA_QUOTA_RECONCILIATION_REQUIRED');
      }
    }
  }
  return { usedBytes, usedFiles };
}

function createQuotaState(limitBytes, maxFiles, usedBytes, usedFiles) {
  return {
    version: QUOTA_VERSION,
    limitBytes,
    maxFiles,
    usedBytes,
    usedFiles,
    reservedBytes: 0,
    reservedFiles: 0,
    reservations: {},
    released: {}
  };
}

function quotaStateSize(state) {
  return Buffer.byteLength(JSON.stringify(state), 'utf8');
}

function validQuotaState(quota) {
  if (!quota || quota.version !== QUOTA_VERSION || !validMediaSize(quota.limitBytes) || quota.limitBytes <= 0 ||
      !validMediaSize(quota.maxFiles) || quota.maxFiles <= 0 || !validMediaSize(quota.usedBytes) ||
      !validMediaSize(quota.usedFiles) || !validMediaSize(quota.reservedBytes) || !validMediaSize(quota.reservedFiles) ||
      !quota.reservations || typeof quota.reservations !== 'object' || !quota.released || typeof quota.released !== 'object') return false;
  return Object.values(quota.reservations).every(value => value && typeof value === 'object' &&
    ['reserved', 'committed', 'released'].includes(value.status) && validMediaSize(value.size) &&
    typeof value.profileId === 'string' && typeof value.mediaId === 'string' && /^[a-f0-9]{64}$/.test(value.sha256 || '') &&
    (!value.objectName || validObjectName(value.objectName)));
}

function createCareMediaQuota({ store, encryption, config, now = Date.now }) {
  if (!store || !encryption || !config) throw new TypeError('Care media quota dependencies are required');

  function requireAvailable() {
    if (!config.available || !validMediaSize(config.limitBytes) || config.limitBytes <= 0 || !validMediaSize(config.maxFiles) || config.maxFiles <= 0) {
      fail(503, 'MEDIA_QUOTA_NOT_CONFIGURED');
    }
  }

  async function loadFamily(familyId) {
    const family = await store.getFamily(familyId);
    if (!family) fail(403, 'FAMILY_ACCESS_DENIED');
    let state;
    try {
      state = encryption.open(family.sealed, `family:${familyId}`);
    } catch (_) {
      fail(503, 'MEDIA_QUOTA_RECONCILIATION_REQUIRED');
    }
    return { family, state };
  }

  async function saveFamily(family, state) {
    if (quotaStateSize(state.mediaQuota) > MAX_QUOTA_STATE_BYTES) {
      fail(503, 'MEDIA_QUOTA_RECONCILIATION_REQUIRED');
    }
    return store.casFamily(family._id, family.rev || 0, {
      rev: (family.rev || 0) + 1,
      sealed: encryption.seal(state, `family:${family._id}`)
    });
  }

  async function ensureInitialized(familyId) {
    requireAvailable();
    if (typeof store.listProfilesByFamily !== 'function') {
      fail(503, 'MEDIA_QUOTA_RECONCILIATION_REQUIRED');
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const { family, state } = await loadFamily(familyId);
      if (state.mediaQuota) {
        // A state written by a newer/unknown implementation may contain
        // reservations for objects that profile scans cannot see. Never
        // overwrite it with a scan.
        if (state.mediaQuota.version !== QUOTA_VERSION || !validQuotaState(state.mediaQuota)) {
          fail(503, 'MEDIA_QUOTA_RECONCILIATION_REQUIRED');
        }
        if (state.mediaQuota.limitBytes !== config.limitBytes || state.mediaQuota.maxFiles !== config.maxFiles) {
          fail(503, 'MEDIA_QUOTA_RECONCILIATION_REQUIRED');
        }
        return { family, state, quota: state.mediaQuota };
      }
      const profiles = await store.listProfilesByFamily(familyId);
      const { usedBytes, usedFiles } = calculateExistingUsage(profiles, encryption);
      state.mediaQuota = createQuotaState(config.limitBytes, config.maxFiles, usedBytes, usedFiles);
      if (await saveFamily(family, state)) return { family, state, quota: state.mediaQuota };
    }
    fail(409, 'RETRY_CONCURRENT_CHANGE');
  }

  async function reserve({ familyId, profileId, mediaId, sha256, size, actor, owner, type }) {
    requireAvailable();
    if (!validMediaSize(size) || !profileId || !mediaId || !/^[a-f0-9]{64}$/.test(sha256 || '')) {
      fail(400, 'INVALID_MEDIA');
    }
    const key = reservationKey({ profileId, mediaId, sha256 });
    for (let attempt = 0; attempt < 8; attempt++) {
      const { family, state, quota } = await ensureInitialized(familyId);
      const existing = quota.reservations[key];
      if (existing) {
        if (existing.size !== size || existing.profileId !== profileId || existing.mediaId !== mediaId) {
          fail(409, 'MEDIA_ID_REUSED');
        }
        if (existing.status === 'released') fail(409, 'MEDIA_ID_REUSED');
        // Never let a second process write a second blob for the same media
        // registration. A process crash remains pending/reconciliation, never
        // an inferred upload success.
        if ((existing.actor && existing.actor !== actor) || (Object.prototype.hasOwnProperty.call(existing, 'owner') && existing.owner !== owner) ||
            (existing.type && existing.type !== type)) fail(409, 'MEDIA_ID_REUSED');
        return { key, pending: existing.status === 'reserved', committed: existing.status === 'committed', reservation: clone(existing) };
      }
      if (quota.usedBytes + quota.reservedBytes + size > quota.limitBytes || quota.usedFiles + quota.reservedFiles + 1 > quota.maxFiles) {
        fail(413, 'FAMILY_MEDIA_QUOTA_EXCEEDED');
      }
      quota.reservations[key] = { profileId, mediaId, sha256, size, actor, owner, type, objectName: objectName(), at: now(), status: 'reserved' };
      quota.reservedBytes += size;
      quota.reservedFiles += 1;
      if (await saveFamily(family, state)) return { key, pending: false, reservation: clone(quota.reservations[key]) };
    }
    fail(409, 'RETRY_CONCURRENT_CHANGE');
  }

  async function commit({ familyId, key }) {
    requireAvailable();
    for (let attempt = 0; attempt < 8; attempt++) {
      const { family, state, quota } = await ensureInitialized(familyId);
      const reservation = quota.reservations[key];
      if (!reservation) return { committed: false };
      if (reservation.status === 'committed') return { committed: false };
      if (reservation.status !== 'reserved') return { committed: false };
      if (quota.reservedBytes < reservation.size || quota.reservedFiles < 1) fail(503, 'MEDIA_QUOTA_RECONCILIATION_REQUIRED');
      quota.reservedBytes -= reservation.size;
      quota.reservedFiles -= 1;
      quota.usedBytes += reservation.size;
      quota.usedFiles += 1;
      reservation.status = 'committed';
      if (await saveFamily(family, state)) return { committed: true };
    }
    fail(409, 'RETRY_CONCURRENT_CHANGE');
  }

  async function cancel({ familyId, key }) {
    requireAvailable();
    for (let attempt = 0; attempt < 8; attempt++) {
      const { family, state, quota } = await ensureInitialized(familyId);
      const reservation = quota.reservations[key];
      if (!reservation || reservation.status !== 'reserved') return { cancelled: false };
      if (quota.reservedBytes < reservation.size || quota.reservedFiles < 1) fail(503, 'MEDIA_QUOTA_RECONCILIATION_REQUIRED');
      quota.reservedBytes -= reservation.size;
      quota.reservedFiles -= 1;
      delete quota.reservations[key];
      if (await saveFamily(family, state)) return { cancelled: true };
    }
    fail(409, 'RETRY_CONCURRENT_CHANGE');
  }

  async function release({ familyId, profileId, mediaId, sha256, size }) {
    requireAvailable();
    if (!validMediaSize(size)) fail(503, 'MEDIA_QUOTA_RECONCILIATION_REQUIRED');
    const key = reservationKey({ profileId, mediaId, sha256 });
    const legacyKey = releasedKey({ profileId, mediaId, sha256 });
    for (let attempt = 0; attempt < 8; attempt++) {
      const { family, state, quota } = await ensureInitialized(familyId);
      const reservation = quota.reservations[key];
      if (reservation && reservation.status === 'released') return { released: false };
      if (reservation && reservation.status === 'reserved') {
        if (quota.reservedBytes < reservation.size || quota.reservedFiles < 1) fail(503, 'MEDIA_QUOTA_RECONCILIATION_REQUIRED');
        quota.reservedBytes -= reservation.size;
        quota.reservedFiles -= 1;
        reservation.status = 'released';
        if (await saveFamily(family, state)) return { released: true, cancelled: true };
        continue;
      }
      if (!reservation && quota.released[legacyKey]) return { released: false };
      if (quota.usedBytes < size) fail(503, 'MEDIA_QUOTA_RECONCILIATION_REQUIRED');
      quota.usedBytes -= size;
      if (quota.usedFiles < 1) fail(503, 'MEDIA_QUOTA_RECONCILIATION_REQUIRED');
      quota.usedFiles -= 1;
      if (reservation) {
        if (reservation.status !== 'committed' || reservation.size !== size) fail(503, 'MEDIA_QUOTA_RECONCILIATION_REQUIRED');
        reservation.status = 'released';
      } else {
        quota.released[legacyKey] = { size, at: now() };
      }
      if (await saveFamily(family, state)) return { released: true };
    }
    fail(409, 'RETRY_CONCURRENT_CHANGE');
  }

  return { available: config.available, cancel, commit, ensureInitialized, release, reserve };
}

module.exports = {
  MAX_QUOTA_STATE_BYTES,
  QUOTA_VERSION,
  calculateExistingUsage,
  createCareMediaQuota,
  reservationKey,
  resolveCareMediaQuotaConfig
};

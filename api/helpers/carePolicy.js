'use strict';

const DAY = 86400000;
const ROLES = ['patient', 'relative', 'professional'];
const SHARED_PREFERENCES = ['language', 'speechRate', 'preferredWords', 'fontSize', 'cardDensity', 'personalImagePreferences'];
function fail(status, code) {
  throw Object.assign(new Error(code), { status, code });
}
function entitlement(subscription, now = Date.now()) {
  const expiresAt = Number(subscription && subscription.expiresAt);
  const startsAt = Number(subscription && subscription.startsAt);
  const active = Number.isFinite(expiresAt) && startsAt <= now && now < expiresAt;
  const downloadUntil = Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt + 30 * DAY : null;
  const grace = !active && downloadUntil !== null && now >= expiresAt && now < downloadUntil;
  return {
    state: active ? 'active' : grace ? 'download_grace' : 'inactive',
    syncWrite: active, download: active || grace, ai: active,
    expiresAt: expiresAt > 0 ? expiresAt : null, downloadUntil,
    localUse: true, localExport: true
  };
}
function requireEntitlement(value, operation) {
  if (operation === 'write' && !value.syncWrite) fail(403, 'SUBSCRIPTION_EXPIRED');
  if (operation === 'download' && !value.download) fail(403, 'DOWNLOAD_PERIOD_ENDED');
}
function relationship(value) {
  const role = value && value.role;
  if (!ROLES.includes(role)) fail(400, 'INVALID_USAGE_ROLE');
  return { role, defaultMode: role === 'patient' ? 'expression' : 'receiver' };
}
module.exports = { DAY, ROLES, SHARED_PREFERENCES, entitlement, requireEntitlement, relationship, fail };

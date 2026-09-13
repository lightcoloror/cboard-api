'use strict';
const crypto = require('crypto');
const { fail } = require('./carePolicy');
const valid = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v);
const clone = v => JSON.parse(JSON.stringify(v));

// Personal originals never enter a profile snapshot. Family publication is an
// explicit action; its source reference is not an authorization credential.
function createCareFavorites({ store, encryption, now = Date.now }) {
  async function load(owner) {
    const doc = await store.getAccount(owner);
    return { doc, state: doc ? encryption.open(doc.sealed, `account:${owner}`) : { selectedProfileId: null } };
  }
  return {
    async list(owner) { const { state } = await load(owner); return Object.values(state.favorites || {}); },
    async get(owner, favoriteId) { const { state } = await load(owner); return (state.favorites || {})[favoriteId] || null; },
    async audit(owner, profileId) { const { state } = await load(owner); return (state.favoriteAudit || []).filter(item => item.profileId === profileId); },
    async write(owner, actor, body, profileId) {
      if (!valid(body.resourceId) || !valid(body.operationId) || !Number.isSafeInteger(body.baseVersion) || body.baseVersion < 0 || !['put', 'delete'].includes(body.action)) fail(400, 'INVALID_FAVORITE');
      if (body.action === 'put' && (!body.value || typeof body.value.sentence !== 'string' || !body.value.sentence.trim() || body.value.sentence.length > 5000 || Buffer.byteLength(JSON.stringify(body.value)) > 256 * 1024)) fail(400, 'INVALID_FAVORITE');
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ body, profileId })).digest('hex');
      const key = `${actor}:${body.operationId}`;
      for (let attempt = 0; attempt < 8; attempt++) {
        const { doc, state } = await load(owner);
        state.favorites = state.favorites || {};
        state.favoriteReceipts = state.favoriteReceipts || {};
        const receipt = state.favoriteReceipts[key];
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) fail(409, 'OPERATION_ID_REUSED');
          return receipt.result;
        }
        const old = state.favorites[body.resourceId];
        if (old && old.profileId !== profileId) fail(403, 'FAVORITE_SCOPE_DENIED');
        if ((old ? old.version : 0) !== body.baseVersion || (old && old.deleted)) return { conflict: true, current: old || null };
        const resource = { id: body.resourceId, owner, profileId, version: body.baseVersion + 1,
          deleted: body.action === 'delete', value: body.action === 'delete' ? null : clone(body.value), updatedAt: now(), updatedBy: actor };
        state.favorites[body.resourceId] = resource;
        const result = { resource };
        state.favoriteReceipts[key] = { fingerprint, result };
        state.favoriteAudit = [...(state.favoriteAudit || []), { actor, action: `favorite.${body.action}`, target: body.resourceId, profileId, revision: resource.version, at: now() }];
        if (Buffer.byteLength(JSON.stringify(state)) > 5 * 1024 * 1024) fail(413, 'ACCOUNT_CAPACITY_REACHED');
        const value = { _id: owner, rev: doc ? doc.rev + 1 : 0, sealed: encryption.seal(state, `account:${owner}`) };
        if (doc ? await store.casAccount(owner, doc.rev, value) : await store.createAccount(value)) return result;
      }
      fail(409, 'RETRY_CONCURRENT_CHANGE');
    }
  };
}
module.exports = { createCareFavorites };

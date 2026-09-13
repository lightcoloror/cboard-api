'use strict';
const crypto = require('crypto');
const policy = require('./carePolicy');
const id = () => crypto.randomBytes(16).toString('hex');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const permissions = ['read', 'library.edit', 'preferences.edit', 'members.manage'];
const fail = (status, code) => { const e = new Error(code); e.status = status; e.code = code; throw e; };
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
function mediaReferences(value, ids = new Set(), depth = 0) {
  if (depth > 24) fail(400, 'INVALID_VALUE_DEPTH');
  if (value && typeof value === 'object') {
    if (value.mediaId) ids.add(value.mediaId);
    for (const item of Object.values(value)) mediaReferences(item, ids, depth + 1);
  }
  return ids;
}
function text(value, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'INVALID_TEXT');
  return value.trim();
}
function createCareService({ store, encryption, media, now = () => Date.now(), enforceEntitlements = false }) {
  const favorites = require('./careFavorites').createCareFavorites({ store, encryption, now });
  async function familyPolicy(familyId) {
    const family = await store.getFamily(familyId);
    if (!family) fail(403, 'FAMILY_ACCESS_DENIED');
    const state = encryption.open(family.sealed, `family:${familyId}`);
    return { family, state, rights: policy.entitlement(state.subscription, now()) };
  }
  async function checkEntitlement(familyId, operation) {
    if (enforceEntitlements) policy.requireEntitlement((await familyPolicy(familyId)).rights, operation);
  }
  async function load(profileId, user, permission = 'read') {
    if (!validId(profileId)) fail(400, 'INVALID_PROFILE');
    const doc = await store.getProfile(profileId);
    if (!doc) fail(403, 'PROFILE_ACCESS_DENIED');
    const state = encryption.open(doc.sealed, `profile:${profileId}`);
    const family = await store.getFamily(doc.familyId);
    const previousAdmin = state.adminOwner || doc.owner;
    if (family && family.owner !== previousAdmin) {
      if (state.grants[previousAdmin]) state.grants[previousAdmin] = state.grants[previousAdmin].filter(p => p !== 'members.manage');
      state.grants[family.owner] = [...permissions];
      state.adminOwner = family.owner;
    }
    if (family) doc.owner = family.owner;
    if (state.deleted || !state.grants[user] || !state.grants[user].includes(permission)) fail(403, 'PROFILE_ACCESS_DENIED');
    return { doc, state };
  }
  async function save(doc, state) {
    if (Buffer.byteLength(JSON.stringify(state)) > 5 * 1024 * 1024) fail(413, 'PROFILE_CAPACITY_REACHED');
    const sealed = encryption.seal(state, `profile:${doc._id}`);
    return store.casProfile(doc._id, doc.rev, { sealed, rev: doc.rev + 1, members: Object.keys(state.grants) });
  }
  function audit(state, actor, action, target, revision) {
    state.audit.push({ actor, action, target, revision, at: now() });
  }
  function view(doc, state, user, since = -1) {
    return { id: doc._id, familyId: doc.familyId, name: state.name, cursor: doc.rev,
      permissions: state.grants[user], owner: doc.owner === user,
      resources: Object.values(state.resources).filter(r => r.seq > since),
      ...(state.grants[user].includes('members.manage') ? { members: state.grants,
        invitations: Object.entries(state.invites).map(([invitationId, v]) => ({ invitationId,
          expiresAt: v.expiresAt, revoked: v.revoked, acceptedBy: v.acceptedBy, permissions: v.permissions })) } : {}) };
  }
  function accessibleMedia(state, user, mediaId) {
    const entry = state.media && state.media[mediaId];
    return entry && !entry.deleted && (!entry.owner || entry.owner === user ||
      Object.values(state.resources).some(r => !r.deleted && mediaReferences(r.value).has(mediaId)));
  }
  async function pinFavoriteMedia(profileId, user, value) {
    if (!mediaReferences(value).size) return;
    await mutate(profileId, user, 'read', (state) => {
      for (const mediaId of mediaReferences(value)) {
        if (!validId(mediaId) || !accessibleMedia(state, user, mediaId)) fail(400, 'MEDIA_NOT_READY');
        // Retain pins until explicit storage reconciliation; a concurrent original
        // write must never race physical deletion of its attachment.
        state.media[mediaId].favoritePinned = true;
      }
      return { value: true };
    });
  }
  async function mutate(profileId, user, permission, fn, securityOnly = false) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { doc, state } = await load(profileId, user, permission);
      if (!securityOnly) await checkEntitlement(doc.familyId, 'write');
      const result = await fn(state, doc);
      if (result.noWrite) return result.value;
      if (await save(doc, state)) return result.value;
    }
    fail(409, 'RETRY_CONCURRENT_CHANGE');
  }
  return {
    async transferAdmin(user, profileId, body) {
      if (!validId(body.member) || !validId(body.operationId)) fail(400, 'INVALID_ADMINISTRATOR');
      for (let attempt = 0; attempt < 8; attempt++) {
        const { doc, state } = await load(profileId, user, 'read');
        const { family, state: familyState } = await familyPolicy(doc.familyId);
        familyState.adminReceipts = familyState.adminReceipts || {};
        const key = `${user}:${body.operationId}`;
        if (familyState.adminReceipts[key]) {
          if (familyState.adminReceipts[key] !== body.member) fail(409, 'OPERATION_ID_REUSED');
          return { ok: true };
        }
        if (family.owner !== user || !state.grants[body.member]) fail(403, 'OWNER_REQUIRED');
        await checkEntitlement(doc.familyId, 'write');
        familyState.adminReceipts[key] = body.member;
        familyState.audit = [...(familyState.audit || []), { actor: user, action: 'administrator.transfer', target: body.member, at: now() }];
        if (await store.casFamily(family._id, family.rev || 0, { owner: body.member, rev: (family.rev || 0) + 1, sealed: encryption.seal(familyState, `family:${family._id}`) })) return { ok: true };
      }
      fail(409, 'RETRY_CONCURRENT_CHANGE');
    },
    async favorites(user, profileId) {
      const { doc } = await load(profileId, user);
      await checkEntitlement(doc.familyId, 'download');
      return { items: (await favorites.list(user)).filter(r => r.profileId === profileId) };
    },
    async favorite(user, profileId, body) {
      const { doc, state } = await load(profileId, user);
      await checkEntitlement(doc.familyId, 'write');
      await pinFavoriteMedia(profileId, user, body.value);
      return favorites.write(user, user, body, profileId);
    },
    async context(user, body) {
      if (!store.getAccount) fail(503, 'ACCOUNT_STORE_UNAVAILABLE');
      for (let attempt = 0; attempt < 8; attempt++) {
        const doc = await store.getAccount(user);
        const state = doc ? encryption.open(doc.sealed, `account:${user}`) : { selectedProfileId: null };
        if (body !== undefined) {
          if (body.profileId !== null) await load(body.profileId, user);
          state.selectedProfileId = body.profileId;
          const value = { _id: user, rev: doc ? doc.rev + 1 : 0, sealed: encryption.seal(state, `account:${user}`) };
          if (!(doc ? await store.casAccount(user, doc.rev, value) : await store.createAccount(value))) continue;
        }
        if (state.selectedProfileId) {
          try { await load(state.selectedProfileId, user); } catch (e) {
            if (e.code !== 'PROFILE_ACCESS_DENIED') throw e;
            return { selectedProfileId: null };
          }
        }
        return { selectedProfileId: state.selectedProfileId };
      }
      fail(409, 'RETRY_CONCURRENT_CHANGE');
    },
    async entitlements(user, profileId) {
      const { doc } = await load(profileId, user);
      return (await familyPolicy(doc.familyId)).rights;
    },
    async families(user) {
      return (await store.listFamilies(user)).map(doc => ({ id: doc._id,
        name: encryption.open(doc.sealed, `family:${doc._id}`).name }));
    },
    async createFamily(user, body) {
      const familyId = id();
      await store.createFamily({ _id: familyId, owner: user,
        sealed: encryption.seal({ name: text(body.name), payerId: null, subscription: null }, `family:${familyId}`) });
      return { id: familyId };
    },
    async createProfile(user, body) {
      const family = validId(body.familyId) && await store.getFamily(body.familyId);
      if (!family || family.owner !== user) fail(403, 'FAMILY_ACCESS_DENIED');
      await checkEntitlement(family._id, 'write');
      const profileId = id();
      // Communicator uses a shared-care marker and no patient content in legacy fields.
      await store.createCommunicator(profileId, family._id);
      const state = { name: text(body.name), relationships: { [user]: policy.relationship({ role: body.role || 'relative' }) }, grants: { [user]: permissions }, resources: {}, invites: {}, receipts: {}, audit: [] };
      await store.createProfile({ _id: profileId, familyId: family._id, owner: user, members: [user], rev: 0,
        sealed: encryption.seal(state, `profile:${profileId}`) });
      return { id: profileId };
    },
    async profiles(user) {
      const docs = await store.listProfiles(user);
      const items = await Promise.all(docs.map(async item => {
        try {
          const { doc, state } = await load(item._id, user);
          return { id: doc._id, familyId: doc.familyId, name: state.name,
            relationship: (state.relationships || {})[user] || null, permissions: state.grants[user], owner: doc.owner === user };
        } catch (e) { if (e.code === 'PROFILE_ACCESS_DENIED') return null; throw e; }
      }));
      return items.filter(Boolean);
    },
    async snapshot(user, profileId, since = -1) {
      const { doc, state } = await load(profileId, user);
      await checkEntitlement(doc.familyId, 'download');
      if (!Number.isSafeInteger(since) || since < -1 || since > doc.rev) fail(400, 'INVALID_CURSOR');
      return { ...view(doc, state, user, since), ...(enforceEntitlements ? { entitlements: (await familyPolicy(doc.familyId)).rights } : {}), relationship: (state.relationships || {})[user] || null };
    },
    async command(user, profileId, body) {
      if (!body || !validId(body.operationId)) fail(400, 'INVALID_OPERATION_ID');
      const action = body.action;
      const permission = ['relationship', 'shareFavorite'].includes(action) || body.kind === 'favorite' ? 'read' : ['invite', 'revokeInvite', 'grant'].includes(action) ? 'members.manage' :
        body.kind === 'preference' ? 'preferences.edit' : 'library.edit';
      const fingerprint = hash(JSON.stringify(body));
      return mutate(profileId, user, permission, async (state, doc) => {
        const receiptKey = `${user}:${body.operationId}`;
        if (state.receipts[receiptKey]) {
          const old = state.receipts[receiptKey];
          if (old.fingerprint !== fingerprint) fail(409, 'OPERATION_ID_REUSED');
          return { noWrite: true, value: old.result };
        }
        let result;
        if (action === 'shareFavorite') {
          if (!validId(body.sourceId) || !validId(body.resourceId)) fail(400, 'INVALID_FAVORITE');
          const source = await favorites.get(user, body.sourceId);
          if (!source || source.deleted || source.profileId !== profileId) fail(403, 'FAVORITE_SCOPE_DENIED');
          if (source.version !== body.sourceVersion) return { noWrite: true, value: { conflict: true, current: source } };
          const key = `favorite:${body.resourceId}`;
          if (state.resources[key]) fail(409, 'RESOURCE_EXISTS');
          const resource = { kind: 'favorite', id: body.resourceId, version: 1, seq: doc.rev + 1, deleted: false,
            value: clone(source.value), source: { owner: user, id: source.id, version: source.version }, createdBy: user, updatedBy: user };
          state.resources[key] = resource;
          result = { resource };
        } else if (action === 'relationship') {
          const member = body.member || user;
          if (!state.grants[member] || (member !== user && !state.grants[user].includes('members.manage'))) fail(403, 'PROFILE_ACCESS_DENIED');
          state.relationships = state.relationships || {};
          state.relationships[member] = policy.relationship(body.value);
          result = { relationship: state.relationships[member] };
        } else if (action === 'invite') {
          const granted = body.permissions;
          if (!Array.isArray(granted) || !granted.includes('read') || granted.some(p => !permissions.includes(p))) fail(400, 'INVALID_GRANT');
          // Only the owner can grant membership administration.
          if (granted.includes('members.manage') && user !== doc.owner) fail(403, 'OWNER_REQUIRED');
          const token = crypto.randomBytes(32).toString('hex'); const invitationId = id();
          state.invites[invitationId] = { hash: hash(token), permissions: [...new Set(granted)],
            expiresAt: now() + 72 * 3600000, revoked: false, acceptedBy: null };
          result = { invitationId, token: `${profileId}.${invitationId}.${token}`, expiresAt: state.invites[invitationId].expiresAt };
        } else if (action === 'revokeInvite') {
          if (!validId(body.invitationId) || !state.invites[body.invitationId]) fail(404, 'INVITATION_NOT_FOUND');
          state.invites[body.invitationId].revoked = true; result = { ok: true };
        } else if (action === 'grant') {
          const member = body.member;
          if (!validId(member) || member === doc.owner || !state.grants[member]) fail(400, 'INVALID_MEMBER');
          if (user !== doc.owner && (state.grants[member].includes('members.manage') || (body.permissions || []).includes('members.manage'))) fail(403, 'OWNER_REQUIRED');
          if (!Array.isArray(body.permissions) || body.permissions.some(p => !permissions.includes(p)) ||
            (body.permissions.length && !body.permissions.includes('read'))) fail(400, 'INVALID_GRANT');
          if (body.permissions.length) state.grants[member] = [...new Set(body.permissions)]; else delete state.grants[member];
          result = { ok: true };
        } else if (action === 'put' || action === 'delete') {
          if (!['board', 'tile', 'preference', 'favorite'].includes(body.kind) || !validId(body.resourceId) ||
            !Number.isSafeInteger(body.baseVersion) || body.baseVersion < 0) fail(400, 'INVALID_RESOURCE');
          const key = `${body.kind}:${body.resourceId}`;
          const old = state.resources[key];
          if (body.kind === 'favorite' && old && user !== doc.owner && old.createdBy !== user && (!old.source || old.source.owner !== user)) fail(403, 'FAVORITE_ADMIN_REQUIRED');
          if ((old ? old.version : 0) !== body.baseVersion || (old && old.deleted)) {
            return { noWrite: true, value: { conflict: true, current: old || null, operationId: body.operationId } };
          }
          if (action === 'put') {
            if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value) ||
              Buffer.byteLength(JSON.stringify(body.value)) > 256 * 1024) fail(400, 'INVALID_VALUE');
            for (const mediaId of mediaReferences(body.value)) {
              if (!validId(mediaId) || !accessibleMedia(state, user, mediaId)) fail(400, 'MEDIA_NOT_READY');
            }
            if (body.kind === 'tile') {
              text(body.value.label, 500);
              if (body.value.mediaId && (!validId(body.value.mediaId) || !state.media || !state.media[body.value.mediaId] || state.media[body.value.mediaId].deleted)) fail(400, 'MEDIA_NOT_READY');
              if (body.value.image || body.value.url || body.value.sound || body.value.video) fail(400, 'USE_PRIVATE_MEDIA_ID');
            }
            if (body.kind === 'favorite') text(body.value.sentence, 5000);
            if (body.kind === 'preference' && !policy.SHARED_PREFERENCES.includes(body.resourceId)) fail(400, 'DEVICE_SETTING_NOT_SHARED');
            if (body.kind === 'preference' && body.resourceId === 'speechRate' &&
                (typeof body.value.value !== 'number' || !Number.isFinite(body.value.value) || body.value.value < 0.5 || body.value.value > 2)) fail(400, 'INVALID_SPEECH_RATE');
            if (body.kind === 'preference' && body.resourceId === 'fontSize' && !['normal', 'large', 'extra-large'].includes(body.value.value)) fail(400, 'INVALID_FONT_SIZE');
            if (body.kind === 'preference' && body.resourceId === 'cardDensity' && ![2, 3, 4].includes(body.value.value)) fail(400, 'INVALID_CARD_DENSITY');
            if (body.kind === 'board' && (!Array.isArray(body.value.tileIds) || body.value.tileIds.length > 2000 ||
                body.value.tileIds.some(v => !validId(v)) || new Set(body.value.tileIds).size !== body.value.tileIds.length)) fail(400, 'INVALID_BOARD_ORDER');
          }
          const resource = { kind: body.kind, id: body.resourceId, version: (old ? old.version : 0) + 1,
            deleted: action === 'delete', value: action === 'delete' ? null : clone(body.value), seq: doc.rev + 1, updatedBy: user,
            createdBy: old ? old.createdBy : user, ...(old && old.source ? { source: old.source } : {}) };
          state.resources[key] = resource; result = { resource, operationId: body.operationId };
        } else { fail(400, 'UNKNOWN_COMMAND'); }
        audit(state, user, action, body.resourceId || body.member || result.invitationId || body.invitationId, doc.rev + 1);
        state.receipts[receiptKey] = { fingerprint, result };
        return { value: result };
      }, action === 'revokeInvite' || (action === 'grant' && Array.isArray(body.permissions) && !body.permissions.length));
    },
    async favoriteOriginal(user, profileId, body) {
      const { doc, state } = await load(profileId, user);
      await checkEntitlement(doc.familyId, 'write');
      if (user !== doc.owner) fail(403, 'OWNER_REQUIRED');
      const shared = state.resources[`favorite:${body.sharedId}`];
      if (!shared || !shared.source) fail(404, 'FAVORITE_SOURCE_NOT_FOUND');
      if (body.sharedVersion !== shared.version) fail(409, 'SHARED_FAVORITE_CHANGED');
      // This endpoint authorizes precisely the original linked to this shared
      // item, never an arbitrary account or public template supplied by a client.
      await pinFavoriteMedia(profileId, user, body.value);
      return favorites.write(shared.source.owner, user, { ...body, resourceId: shared.source.id }, profileId);
    },
    async accept(user, token) {
      if (typeof token !== 'string') fail(400, 'INVALID_INVITATION');
      const [profileId, invitationId, secret, extra] = token.split('.');
      if (extra || !validId(profileId) || !validId(invitationId) || !/^[a-f0-9]{64}$/.test(secret || '')) fail(400, 'INVALID_INVITATION');
      for (let attempt = 0; attempt < 8; attempt++) {
        const doc = await store.getProfile(profileId); if (!doc) fail(403, 'INVALID_INVITATION');
        await checkEntitlement(doc.familyId, 'write');
        const state = encryption.open(doc.sealed, `profile:${profileId}`); const invite = state.invites[invitationId];
        if (state.deleted || !invite || invite.revoked || invite.expiresAt <= now() || invite.hash !== hash(secret)) fail(403, 'INVALID_INVITATION');
        if (invite.acceptedBy) {
          if (invite.acceptedBy === user && state.grants[user]) return { id: profileId };
          fail(403, 'INVITATION_CONSUMED');
        }
        // Re-inviting an existing member must not silently downgrade their grant.
        if (state.grants[user]) fail(409, 'ALREADY_MEMBER');
        state.grants[user] = invite.permissions; invite.acceptedBy = user;
        audit(state, user, 'accept', invitationId, doc.rev + 1);
        if (await save(doc, state)) return { id: profileId };
      }
      fail(409, 'RETRY_CONCURRENT_CHANGE');
    },
    async audit(user, profileId) {
      const { doc, state } = await load(profileId, user); await checkEntitlement(doc.familyId, 'download');
      const family = await familyPolicy(doc.familyId);
      const items = [...state.audit, ...(family.state.audit || []), ...await favorites.audit(user, profileId)];
      if (doc.owner === user) {
        const sources = Object.values(state.resources).filter(r => r.source && r.source.owner !== user);
        for (const owner of new Set(sources.map(r => r.source.owner))) {
          const ids = new Set(sources.filter(r => r.source.owner === owner).map(r => r.source.id));
          items.push(...(await favorites.audit(owner, profileId)).filter(item => item.actor === user && ids.has(item.target)));
        }
      }
      return { items };
    },
    async upload(user, profileId, body) {
      const uploadPermission = body.visibility === 'private' ? 'read' : 'library.edit';
      const { doc: uploadDoc } = await load(profileId, user, uploadPermission);
      await checkEntitlement(uploadDoc.familyId, 'write');
      if (!validId(body.mediaId) || typeof body.data !== 'string' || !/^[a-f0-9]{64}$/.test(body.sha256 || '') ||
          !['image/png', 'image/jpeg', 'image/webp'].includes(body.type) || body.data.length > 6 * 1024 * 1024) fail(400, 'INVALID_MEDIA');
      const buffer = Buffer.from(body.data, 'base64');
      if (!buffer.length || buffer.length > 4 * 1024 * 1024 || hash(buffer) !== body.sha256) fail(400, 'MEDIA_CHECKSUM_MISMATCH');
      const magic = body.type === 'image/png' ? buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) :
        body.type === 'image/jpeg' ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 :
        buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
      if (!magic) fail(400, 'INVALID_IMAGE');
      const context = `media:${profileId}:${body.mediaId}`;
      const blob = await media.write(Buffer.from(JSON.stringify(encryption.seal({ data: body.data }, context))));
      try {
        const result = await mutate(profileId, user, uploadPermission, (state, doc) => {
          state.media = state.media || {};
          const old = state.media[body.mediaId];
          if (old) {
            if (old.deleted || old.sha256 !== body.sha256 || (old.owner && old.owner !== user)) fail(409, 'MEDIA_ID_REUSED');
            return { noWrite: true, value: { id: body.mediaId, reused: true } };
          }
          state.media[body.mediaId] = { blob, owner: body.visibility === 'private' ? user : null, uploadedBy: user, type: body.type, sha256: body.sha256, size: buffer.length, deleted: false };
          audit(state, user, 'media.upload', body.mediaId, doc.rev + 1);
          return { value: { id: body.mediaId } };
        });
        if (result.reused) await media.remove(blob);
        return result;
      } catch (error) { await media.remove(blob).catch(() => {}); throw error; }
    },
    async download(user, profileId, mediaId) {
      const { doc, state } = await load(profileId, user); const entry = state.media && state.media[mediaId];
      await checkEntitlement(doc.familyId, 'download');
      if (!validId(mediaId) || !entry || entry.deleted) fail(404, 'MEDIA_NOT_FOUND');
      if (!accessibleMedia(state, user, mediaId)) fail(403, 'MEDIA_ACCESS_DENIED');
      const envelope = JSON.parse((await media.read(entry.blob)).toString('utf8'));
      const data = encryption.open(envelope, `media:${profileId}:${mediaId}`).data;
      const latest = await load(profileId, user); // Recheck after potentially slow blob retrieval.
      if (!accessibleMedia(latest.state, user, mediaId)) fail(403, 'MEDIA_ACCESS_DENIED');
      await checkEntitlement(doc.familyId, 'download');
      if (hash(Buffer.from(data, 'base64')) !== entry.sha256) fail(503, 'MEDIA_CORRUPT');
      return { data, type: entry.type, sha256: entry.sha256 };
    },
    async deleteMedia(user, profileId, mediaId) {
      const removed = await mutate(profileId, user, 'library.edit', (state, doc) => {
        if (!validId(mediaId) || !state.media || !state.media[mediaId]) fail(404, 'MEDIA_NOT_FOUND');
        if (state.media[mediaId].favoritePinned) fail(409, 'MEDIA_IN_USE');
        if (Object.values(state.resources).some(r => !r.deleted && mediaReferences(r.value).has(mediaId))) fail(409, 'MEDIA_IN_USE');
        state.media[mediaId].deleted = true;
        audit(state, user, 'media.delete', mediaId, doc.rev + 1);
        return { value: { blob: state.media[mediaId].blob } };
      });
      // Access is denied by the tombstone before deletion. A storage failure
      // can be retried without exposing the file again or resurrecting its ID.
      await media.remove(removed.blob);
      return { ok: true };
    }
  };
}
module.exports = { createCareService };

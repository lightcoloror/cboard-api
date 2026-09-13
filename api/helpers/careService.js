'use strict';
const crypto = require('crypto');
const id = () => crypto.randomBytes(16).toString('hex');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const permissions = ['read', 'library.edit', 'preferences.edit', 'members.manage'];
const fail = (status, code) => { const e = new Error(code); e.status = status; e.code = code; throw e; };
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
function text(value, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'INVALID_TEXT');
  return value.trim();
}
function createCareService({ store, encryption, media, now = () => Date.now() }) {
  async function load(profileId, user, permission = 'read') {
    if (!validId(profileId)) fail(400, 'INVALID_PROFILE');
    const doc = await store.getProfile(profileId);
    if (!doc) fail(403, 'PROFILE_ACCESS_DENIED');
    const state = encryption.open(doc.sealed, `profile:${profileId}`);
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
  async function mutate(profileId, user, permission, fn) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { doc, state } = await load(profileId, user, permission);
      const result = await fn(state, doc);
      if (result.noWrite) return result.value;
      if (await save(doc, state)) return result.value;
    }
    fail(409, 'RETRY_CONCURRENT_CHANGE');
  }
  return {
    async families(user) {
      return (await store.listFamilies(user)).map(doc => ({ id: doc._id,
        name: encryption.open(doc.sealed, `family:${doc._id}`).name }));
    },
    async createFamily(user, body) {
      const familyId = id();
      await store.createFamily({ _id: familyId, owner: user,
        sealed: encryption.seal({ name: text(body.name) }, `family:${familyId}`) });
      return { id: familyId };
    },
    async createProfile(user, body) {
      const family = validId(body.familyId) && await store.getFamily(body.familyId);
      if (!family || family.owner !== user) fail(403, 'FAMILY_ACCESS_DENIED');
      const profileId = id();
      // Communicator uses a shared-care marker and no patient content in legacy fields.
      await store.createCommunicator(profileId, family._id);
      const state = { name: text(body.name), grants: { [user]: permissions }, resources: {}, invites: {}, receipts: {}, audit: [] };
      await store.createProfile({ _id: profileId, familyId: family._id, owner: user, members: [user], rev: 0,
        sealed: encryption.seal(state, `profile:${profileId}`) });
      return { id: profileId };
    },
    async profiles(user) {
      const docs = await store.listProfiles(user);
      return docs.map(doc => { const state = encryption.open(doc.sealed, `profile:${doc._id}`);
        return state.deleted || !state.grants[user] ? null : { id: doc._id, familyId: doc.familyId,
          name: state.name, permissions: state.grants[user], owner: doc.owner === user }; }).filter(Boolean);
    },
    async snapshot(user, profileId, since = -1) {
      const { doc, state } = await load(profileId, user);
      if (!Number.isSafeInteger(since) || since < -1 || since > doc.rev) fail(400, 'INVALID_CURSOR');
      return view(doc, state, user, since);
    },
    async command(user, profileId, body) {
      if (!body || !validId(body.operationId)) fail(400, 'INVALID_OPERATION_ID');
      const action = body.action;
      const permission = ['invite', 'revokeInvite', 'grant'].includes(action) ? 'members.manage' :
        body.kind === 'preference' ? 'preferences.edit' : 'library.edit';
      const fingerprint = hash(JSON.stringify(body));
      return mutate(profileId, user, permission, (state, doc) => {
        const receiptKey = `${user}:${body.operationId}`;
        if (state.receipts[receiptKey]) {
          const old = state.receipts[receiptKey];
          if (old.fingerprint !== fingerprint) fail(409, 'OPERATION_ID_REUSED');
          return { noWrite: true, value: old.result };
        }
        let result;
        if (action === 'invite') {
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
          if (!['board', 'tile', 'preference'].includes(body.kind) || !validId(body.resourceId) ||
            !Number.isSafeInteger(body.baseVersion) || body.baseVersion < 0) fail(400, 'INVALID_RESOURCE');
          const key = `${body.kind}:${body.resourceId}`;
          const old = state.resources[key];
          if ((old ? old.version : 0) !== body.baseVersion || (old && old.deleted)) {
            return { noWrite: true, value: { conflict: true, current: old || null, operationId: body.operationId } };
          }
          if (action === 'put') {
            if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value) ||
              Buffer.byteLength(JSON.stringify(body.value)) > 256 * 1024) fail(400, 'INVALID_VALUE');
            if (body.kind === 'tile') {
              text(body.value.label, 500);
              if (body.value.mediaId && (!validId(body.value.mediaId) || !state.media || !state.media[body.value.mediaId] || state.media[body.value.mediaId].deleted)) fail(400, 'MEDIA_NOT_READY');
              if (body.value.image || body.value.url || body.value.sound || body.value.video) fail(400, 'USE_PRIVATE_MEDIA_ID');
            }
            if (body.kind === 'preference' && !['language', 'speechRate', 'preferredWords', 'communicationMode'].includes(body.resourceId)) fail(400, 'DEVICE_SETTING_NOT_SHARED');
            if (body.kind === 'preference' && body.resourceId === 'speechRate' &&
                (typeof body.value.value !== 'number' || !Number.isFinite(body.value.value) || body.value.value < 0.5 || body.value.value > 2)) fail(400, 'INVALID_SPEECH_RATE');
            if (body.kind === 'board' && (!Array.isArray(body.value.tileIds) || body.value.tileIds.length > 2000 ||
                body.value.tileIds.some(v => !validId(v)) || new Set(body.value.tileIds).size !== body.value.tileIds.length)) fail(400, 'INVALID_BOARD_ORDER');
          }
          const resource = { kind: body.kind, id: body.resourceId, version: (old ? old.version : 0) + 1,
            deleted: action === 'delete', value: action === 'delete' ? null : clone(body.value), seq: doc.rev + 1, updatedBy: user };
          state.resources[key] = resource; result = { resource, operationId: body.operationId };
        } else { fail(400, 'UNKNOWN_COMMAND'); }
        audit(state, user, action, body.resourceId || body.member || result.invitationId || body.invitationId, doc.rev + 1);
        state.receipts[receiptKey] = { fingerprint, result };
        return { value: result };
      });
    },
    async accept(user, token) {
      if (typeof token !== 'string') fail(400, 'INVALID_INVITATION');
      const [profileId, invitationId, secret, extra] = token.split('.');
      if (extra || !validId(profileId) || !validId(invitationId) || !/^[a-f0-9]{64}$/.test(secret || '')) fail(400, 'INVALID_INVITATION');
      for (let attempt = 0; attempt < 8; attempt++) {
        const doc = await store.getProfile(profileId); if (!doc) fail(403, 'INVALID_INVITATION');
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
    async audit(user, profileId) { const { state } = await load(profileId, user); return { items: state.audit }; },
    async upload(user, profileId, body) {
      await load(profileId, user, 'library.edit');
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
        const result = await mutate(profileId, user, 'library.edit', (state, doc) => {
          state.media = state.media || {};
          const old = state.media[body.mediaId];
          if (old) {
            if (old.deleted || old.sha256 !== body.sha256) fail(409, 'MEDIA_ID_REUSED');
            return { noWrite: true, value: { id: body.mediaId, reused: true } };
          }
          state.media[body.mediaId] = { blob, type: body.type, sha256: body.sha256, size: buffer.length, deleted: false };
          audit(state, user, 'media.upload', body.mediaId, doc.rev + 1);
          return { value: { id: body.mediaId } };
        });
        if (result.reused) await media.remove(blob);
        return result;
      } catch (error) { await media.remove(blob).catch(() => {}); throw error; }
    },
    async download(user, profileId, mediaId) {
      const { state } = await load(profileId, user); const entry = state.media && state.media[mediaId];
      if (!validId(mediaId) || !entry || entry.deleted) fail(404, 'MEDIA_NOT_FOUND');
      const envelope = JSON.parse((await media.read(entry.blob)).toString('utf8'));
      const data = encryption.open(envelope, `media:${profileId}:${mediaId}`).data;
      await load(profileId, user); // Recheck after potentially slow blob retrieval.
      if (hash(Buffer.from(data, 'base64')) !== entry.sha256) fail(503, 'MEDIA_CORRUPT');
      return { data, type: entry.type, sha256: entry.sha256 };
    },
    async deleteMedia(user, profileId, mediaId) {
      const removed = await mutate(profileId, user, 'library.edit', (state, doc) => {
        if (!validId(mediaId) || !state.media || !state.media[mediaId]) fail(404, 'MEDIA_NOT_FOUND');
        if (Object.values(state.resources).some(r => !r.deleted && r.kind === 'tile' && r.value.mediaId === mediaId)) fail(409, 'MEDIA_IN_USE');
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

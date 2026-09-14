'use strict';
const assert = require('assert').strict;
const crypto = require('crypto');
const { createCareService } = require('../../api/helpers/careService');
const { createCareCrypto } = require('../../api/helpers/careCrypto');
const { createCareMediaQuota, resolveCareMediaQuotaConfig } = require('../../api/helpers/careMediaQuota');
const { createCareSync } = require('../../../cboard/src/common/communicationSupport/careSync');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const newId = () => crypto.randomBytes(16).toString('hex');
function fixture() {
  const families = {}, profiles = {}, blobs = {}, accounts = {};
  const keys = { test: crypto.randomBytes(32).toString('hex') };
  const encryption = createCareCrypto(keys, 'test');
  const store = {
    getAccount: async id => clone(accounts[id]),
    createAccount: async d => { if (accounts[d._id]) return false; accounts[d._id] = clone(d); return true; },
    casAccount: async (id, rev, update) => { if (accounts[id].rev !== rev) return false; accounts[id] = { ...accounts[id], ...clone(update) }; return true; },
    createFamily: async d => { families[d._id] = clone(d); },
    getFamily: async id => clone(families[id]),
    casFamily: async (id, rev, update) => { if ((families[id].rev || 0) !== rev) return false; families[id] = { ...families[id], ...clone(update) }; return true; },
    listFamilies: async u => clone(Object.values(families).filter(f => f.owner === u)),
    createCommunicator: async () => {},
    createProfile: async d => { profiles[d._id] = clone(d); },
    getProfile: async id => clone(profiles[id]),
    listProfiles: async u => clone(Object.values(profiles).filter(p => p.members.includes(u))),
    listProfilesByFamily: async familyId => clone(Object.values(profiles).filter(p => p.familyId === familyId)),
    casProfile: async (id, rev, update) => {
      if (profiles[id].rev !== rev) return false;
      profiles[id] = { ...profiles[id], ...clone(update) }; return true;
    }
  };
  const media = { write: async data => { const k = newId(); blobs[k] = Buffer.from(data); return k; },
    read: async k => blobs[k], remove: async k => { delete blobs[k]; } };
  const service = createCareService({ store, encryption, media });
  return { service, profiles, families, blobs, encryption, store, keys, media };
}
async function setup(f, user = 'familyA') {
  const family = await f.service.createFamily(user, { name: '合成家庭' });
  const profile = await f.service.createProfile(user, { familyId: family.id, name: '合成患者' });
  return { family, profile };
}
const command = (resourceId = 'one', value = { label: '喝水' }, baseVersion = 0) =>
  ({ action: 'put', kind: 'tile', operationId: newId(), resourceId, baseVersion, value });
async function invite(f, p, member, grant = ['read', 'library.edit', 'preferences.edit']) {
  const v = await f.service.command('familyA', p, { action: 'invite', operationId: newId(), permissions: grant });
  await f.service.accept(member, v.token); return v;
}
describe('patient collaboration security and offline recovery', () => {
  it('protects private favorite media until explicitly shared and retains attachment recovery pins', async () => {
    const f = fixture(); const { profile } = await setup(f); await invite(f, profile.id, 'reader', ['read']);
    const data = Buffer.from('89504e470d0a1a0a112233', 'hex');
    const asset = { mediaId: 'private-photo', visibility: 'private', type: 'image/png', data: data.toString('base64'), sha256: crypto.createHash('sha256').update(data).digest('hex') };
    await f.service.upload('reader', profile.id, asset);
    await assert.rejects(f.service.download('familyA', profile.id, asset.mediaId), e => e.code === 'MEDIA_ACCESS_DENIED');
    await f.service.favorite('reader', profile.id, { operationId: newId(), resourceId: 'original', action: 'put', baseVersion: 0, value: { sentence: '合成私人收藏', mediaId: asset.mediaId } });
    await assert.rejects(f.service.deleteMedia('familyA', profile.id, asset.mediaId), e => e.code === 'MEDIA_IN_USE');
    await f.service.command('reader', profile.id, { operationId: newId(), action: 'shareFavorite', resourceId: 'shared', sourceId: 'original', sourceVersion: 1 });
    assert.equal((await f.service.download('familyA', profile.id, asset.mediaId)).data, asset.data);
  });
  it('keeps subscription renewal independent of administrator transfer and allows revocation after expiry', async () => {
    const f = fixture(); const { family, profile } = await setup(f); await invite(f, profile.id, 'member');
    const subscriptions = require('../../api/helpers/careSubscription').createCareSubscription({ store: f.store, encryption: f.encryption });
    await subscriptions.activate({ familyId: family.id, payerId: 'familyA', receiptId: 'first', startsAt: 1, expiresAt: 10 });
    await f.service.transferAdmin('familyA', profile.id, { member: 'member', operationId: newId() });
    await f.service.command('member', profile.id, command());
    await subscriptions.activate({ familyId: family.id, payerId: 'familyA', receiptId: 'renew', startsAt: 11, expiresAt: 20 });
    assert.equal(f.families[family.id].owner, 'member');
    await f.service.transferAdmin('member', profile.id, { member: 'familyA', operationId: newId() });
    assert(!(await f.service.snapshot('member', profile.id)).permissions.includes('members.manage'));
    const gated = createCareService({ store: f.store, encryption: f.encryption, media: f.media, enforceEntitlements: true, now: () => 100 });
    await assert.rejects(gated.command('familyA', profile.id, command('new')), e => e.code === 'SUBSCRIPTION_EXPIRED');
    await gated.command('familyA', profile.id, { action: 'grant', member: 'member', permissions: [], operationId: newId() });
    await assert.rejects(gated.snapshot('member', profile.id), e => e.code === 'PROFILE_ACCESS_DENIED');
  });
  it('keeps personal originals private and scopes optional original updates to a family share', async () => {
    const f = fixture(); const { profile } = await setup(f);
    await invite(f, profile.id, 'therapist');
    const original = { operationId: newId(), action: 'put', resourceId: 'phrase', baseVersion: 0, value: { sentence: '合成收藏' } };
    await f.service.favorite('therapist', profile.id, original);
    assert.equal((await f.service.snapshot('familyA', profile.id)).resources.length, 0);
    assert.equal((await f.service.favorites('familyA', profile.id)).items.length, 0);
    const share = await f.service.command('therapist', profile.id, { action: 'shareFavorite', operationId: newId(), sourceId: 'phrase', sourceVersion: 1, resourceId: 'shared' });
    assert.equal(share.resource.value.sentence, '合成收藏');
    await f.service.command('familyA', profile.id, { action: 'put', kind: 'favorite', operationId: newId(), resourceId: 'shared', baseVersion: 1, value: { sentence: '家庭修改' } });
    assert.equal((await f.service.favorites('therapist', profile.id)).items[0].value.sentence, '合成收藏');
    const sourceUpdate = { ...original, operationId: newId(), baseVersion: 1, sharedId: 'shared', sharedVersion: 2, value: { sentence: '一起修改' } };
    await f.service.favoriteOriginal('familyA', profile.id, sourceUpdate);
    assert.equal((await f.service.favorites('therapist', profile.id)).items[0].value.sentence, '一起修改');
    await assert.rejects(f.service.favoriteOriginal('therapist', profile.id, sourceUpdate), e => e.code === 'OWNER_REQUIRED');
    const other = await setup(f, 'familyB');
    await assert.rejects(f.service.favoriteOriginal('familyB', other.profile.id, sourceUpdate), e => e.code === 'FAVORITE_SOURCE_NOT_FOUND');
  });
  it('persists account selection without granting access and separates role from permission', async () => {
    const f = fixture(); const { profile } = await setup(f);
    await invite(f, profile.id, 'reader', ['read']);
    await f.service.context('reader', { profileId: profile.id });
    await f.service.command('reader', profile.id, { action: 'relationship', operationId: newId(), value: { role: 'patient' } });
    assert.equal((await f.service.profiles('reader'))[0].relationship.defaultMode, 'expression');
    await assert.rejects(f.service.command('reader', profile.id, command()), e => e.status === 403);
    await f.service.command('familyA', profile.id, { action: 'grant', operationId: newId(), member: 'reader', permissions: [] });
    assert.equal((await f.service.context('reader')).selectedProfileId, null);
  });
  it('encrypts data with authenticated context and restores using the separately held key', async () => {
    const f = fixture(); const { profile } = await setup(f);
    await f.service.command('familyA', profile.id, command());
    const backup = JSON.parse(JSON.stringify(f.profiles));
    assert(!JSON.stringify(backup).includes('喝水'));
    const restored = createCareCrypto(f.keys, 'test').open(backup[profile.id].sealed, `profile:${profile.id}`);
    assert.equal(restored.resources['tile:one'].value.label, '喝水');
    assert.throws(() => f.encryption.open(backup[profile.id].sealed, 'profile:other'));
    backup[profile.id].sealed.tag = crypto.randomBytes(16).toString('base64');
    assert.throws(() => f.encryption.open(backup[profile.id].sealed, `profile:${profile.id}`));
  });
  it('enforces one-use invitations, read-only access and revocation without reviving an old invitation', async () => {
    const f = fixture(); const { profile } = await setup(f);
    const v = await invite(f, profile.id, 'reader', ['read']);
    await assert.rejects(f.service.accept('stranger', v.token), e => e.status === 403);
    await assert.rejects(f.service.command('reader', profile.id, command()), e => e.status === 403);
    await f.service.command('familyA', profile.id, { action: 'grant', operationId: newId(), member: 'reader', permissions: [] });
    await assert.rejects(f.service.snapshot('reader', profile.id), e => e.status === 403);
    await assert.rejects(f.service.accept('reader', v.token), e => e.status === 403);
  });
  it('keeps two families isolated even for a shared collaborator and prevents delegation by editors', async () => {
    const f = fixture(); const a = await setup(f); const b = await setup(f, 'familyB');
    await invite(f, a.profile.id, 'therapist');
    await assert.rejects(f.service.snapshot('therapist', b.profile.id), e => e.status === 403);
    await assert.rejects(f.service.command('therapist', a.profile.id, { action: 'invite', operationId: newId(), permissions: ['read'] }), e => e.status === 403);
    const v = await f.service.command('familyB', b.profile.id, { action: 'invite', operationId: newId(), permissions: ['read'] });
    await f.service.accept('therapist', v.token);
    assert.equal((await f.service.profiles('therapist')).length, 2);
    await assert.rejects(f.service.command('therapist', b.profile.id, command()), e => e.status === 403);
    assert.equal((await f.service.audit('therapist', b.profile.id)).items.some(i => i.target === a.profile.id), false);
  });
  it('atomically deduplicates concurrent retries and rejects reuse with different content', async () => {
    const f = fixture(); const { profile } = await setup(f); const op = command();
    const results = await Promise.all([f.service.command('familyA', profile.id, op), f.service.command('familyA', profile.id, op)]);
    assert.deepEqual(results[0], results[1]);
    assert.equal((await f.service.snapshot('familyA', profile.id)).resources.length, 1);
    await assert.rejects(f.service.command('familyA', profile.id, { ...op, value: { label: '不同' } }), e => e.status === 409);
    const conflict = await f.service.command('familyA', profile.id, command()); assert(conflict.conflict);
  });
  it('never resurrects tombstones or allows device-only preferences to enter shared settings', async () => {
    const f = fixture(); const { profile } = await setup(f); await f.service.command('familyA', profile.id, command());
    await f.service.command('familyA', profile.id, { ...command(), action: 'delete', baseVersion: 1 });
    assert((await f.service.command('familyA', profile.id, command('one', { label: '旧修改' }, 2))).conflict);
    await assert.rejects(f.service.command('familyA', profile.id, { ...command('voice'), kind: 'preference' }), e => e.status === 400);
  });
  it('checks media upload, encrypted backup restore, access and tombstone after removal', async () => {
    const f = fixture(); const { profile } = await setup(f);
    const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const asset = { mediaId: 'photo', data: bytes.toString('base64'), type: 'image/png', sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    await assert.rejects(f.service.command('familyA', profile.id, command('one', { label: '照片', mediaId: 'photo' })), e => e.code === 'MEDIA_NOT_READY');
    await f.service.upload('familyA', profile.id, asset); await f.service.upload('familyA', profile.id, asset);
    assert.equal(Object.keys(f.blobs).length, 1);
    assert(!Object.values(f.blobs)[0].toString().includes(asset.data));
    assert.equal((await f.service.download('familyA', profile.id, 'photo')).data, asset.data);
    await assert.rejects(f.service.download('stranger', profile.id, 'photo'), e => e.status === 403);
    await f.service.deleteMedia('familyA', profile.id, 'photo');
    assert.equal(Object.keys(f.blobs).length, 0);
    await assert.rejects(f.service.download('familyA', profile.id, 'photo'), e => e.status === 404);
  });
  it('reserves family media capacity once, releases it only after deletion, and finalizes a lost commit without another write', async () => {
    const f = fixture(); const { profile, family } = await setup(f);
    const quota = createCareMediaQuota({ store: f.store, encryption: f.encryption,
      config: resolveCareMediaQuotaConfig({ CARE_FAMILY_MEDIA_QUOTA_BYTES: '24', CARE_FAMILY_MEDIA_QUOTA_MAX_FILES: '2' }) });
    let writes = 0; let failCommit = true;
    const service = createCareService({ store: f.store, encryption: f.encryption, media: {
      async write(data) { writes += 1; return f.media.write(data); }, read: f.media.read, remove: f.media.remove
    }, mediaQuota: {
      available: true,
      ensureInitialized: quota.ensureInitialized,
      reserve: quota.reserve,
      cancel: quota.cancel,
      release: quota.release,
      async commit(value) { if (failCommit) { failCommit = false; throw Object.assign(new Error('synthetic commit failure'), { code: 'RETRY_CONCURRENT_CHANGE' }); } return quota.commit(value); }
    } });
    const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const asset = { mediaId: 'quota-photo', data: bytes.toString('base64'), type: 'image/png', sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    await assert.rejects(service.upload('familyA', profile.id, asset), e => e.code === 'RETRY_CONCURRENT_CHANGE');
    assert.equal(writes, 1);
    assert.equal((await service.upload('familyA', profile.id, asset)).reused, true);
    assert.equal(writes, 1);
    await service.deleteMedia('familyA', profile.id, asset.mediaId);
    const quotaState = f.encryption.open(f.families[family.id].sealed, `family:${family.id}`).mediaQuota;
    assert.equal(quotaState.usedBytes, 0);
  });
  it('returns a retryable unfinished error to a concurrent uploader and keeps its media unreferencable', async () => {
    const f = fixture(); const { profile, family } = await setup(f);
    const quota = createCareMediaQuota({ store: f.store, encryption: f.encryption,
      config: resolveCareMediaQuotaConfig({ CARE_FAMILY_MEDIA_QUOTA_BYTES: '24', CARE_FAMILY_MEDIA_QUOTA_MAX_FILES: '2' }) });
    let writes = 0; let failRemove = false;
    const service = createCareService({ store: f.store, encryption: f.encryption, media: {
      async write(data) { writes += 1; await new Promise(resolve => setImmediate(resolve)); return f.media.write(data); },
      read: f.media.read,
      async remove(name) { if (failRemove) throw new Error('synthetic remove failure'); return f.media.remove(name); }
    }, mediaQuota: quota });
    const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const asset = { mediaId: 'parallel-photo', data: bytes.toString('base64'), type: 'image/png', sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    const results = await Promise.allSettled([service.upload('familyA', profile.id, asset), service.upload('familyA', profile.id, asset)]);
    assert.equal(writes, 1);
    assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'MEDIA_UPLOAD_PENDING_RECONCILIATION').length, 1);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await service.snapshot('familyA', profile.id)).resources.length, 0);
    failRemove = true;
    await assert.rejects(service.deleteMedia('familyA', profile.id, asset.mediaId));
    let quotaState = f.encryption.open(f.families[family.id].sealed, `family:${family.id}`).mediaQuota;
    assert.equal(quotaState.usedBytes, bytes.length);
    failRemove = false;
    await service.deleteMedia('familyA', profile.id, asset.mediaId);
    quotaState = f.encryption.open(f.families[family.id].sealed, `family:${family.id}`).mediaQuota;
    assert.equal(quotaState.usedBytes, 0);
  });
  it('uses the committed receipt when a request read no media before another writer finalized', async () => {
    const f = fixture(); const { profile } = await setup(f);
    const quota = createCareMediaQuota({ store: f.store, encryption: f.encryption,
      config: resolveCareMediaQuotaConfig({ CARE_FAMILY_MEDIA_QUOTA_BYTES: '24', CARE_FAMILY_MEDIA_QUOTA_MAX_FILES: '2' }) });
    let writes = 0; let holdSecond = true; let releaseSecond; let secondAtReserve;
    const waiting = new Promise(resolve => { releaseSecond = resolve; });
    const secondReached = new Promise(resolve => { secondAtReserve = resolve; });
    const service = createCareService({ store: f.store, encryption: f.encryption, media: {
      async write(data) { writes += 1; return f.media.write(data); }, read: f.media.read, remove: f.media.remove
    }, mediaQuota: {
      available: true, ensureInitialized: quota.ensureInitialized, commit: quota.commit, cancel: quota.cancel, release: quota.release,
      async reserve(request) {
        if (holdSecond) { holdSecond = false; secondAtReserve(); await waiting; }
        return quota.reserve(request);
      }
    } });
    const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const asset = { mediaId: 'late-photo', data: bytes.toString('base64'), type: 'image/png', sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    const late = service.upload('familyA', profile.id, asset);
    await secondReached;
    const first = await service.upload('familyA', profile.id, asset);
    releaseSecond();
    const second = await late;
    assert.equal(writes, 1);
    assert.equal(first.id, asset.mediaId);
    assert.equal(second.reused, true);
  });
  it('does not let a late reader treat another member private media as its own', async () => {
    const f = fixture(); const { profile } = await setup(f); await invite(f, profile.id, 'reader', ['read']);
    const quota = createCareMediaQuota({ store: f.store, encryption: f.encryption,
      config: resolveCareMediaQuotaConfig({ CARE_FAMILY_MEDIA_QUOTA_BYTES: '24', CARE_FAMILY_MEDIA_QUOTA_MAX_FILES: '2' }) });
    let hold = true; let release; let reached;
    const waiting = new Promise(resolve => { release = resolve; });
    const atReserve = new Promise(resolve => { reached = resolve; });
    const service = createCareService({ store: f.store, encryption: f.encryption, media: f.media, mediaQuota: {
      available: true, ensureInitialized: quota.ensureInitialized, commit: quota.commit, cancel: quota.cancel, release: quota.release,
      async reserve(request) { if (hold) { hold = false; reached(); await waiting; } return quota.reserve(request); }
    } });
    const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const asset = { mediaId: 'private-late-photo', visibility: 'private', data: bytes.toString('base64'), type: 'image/png', sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    const late = service.upload('reader', profile.id, asset);
    await atReserve;
    await service.upload('familyA', profile.id, asset);
    release();
    await assert.rejects(late, error => error.code === 'MEDIA_ID_REUSED');
  });
  it('keeps an uncertain write reservation and initializes before releasing a legacy deletion', async () => {
    const f = fixture(); const { profile, family } = await setup(f);
    const quota = createCareMediaQuota({ store: f.store, encryption: f.encryption,
      config: resolveCareMediaQuotaConfig({ CARE_FAMILY_MEDIA_QUOTA_BYTES: '24', CARE_FAMILY_MEDIA_QUOTA_MAX_FILES: '2' }) });
    const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const asset = { mediaId: 'legacy-photo', data: bytes.toString('base64'), type: 'image/png', sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    await f.service.upload('familyA', profile.id, asset);
    const guarded = createCareService({ store: f.store, encryption: f.encryption, media: f.media, mediaQuota: quota });
    await guarded.deleteMedia('familyA', profile.id, asset.mediaId);
    let state = f.encryption.open(f.families[family.id].sealed, `family:${family.id}`).mediaQuota;
    assert.equal(state.usedBytes, 0);
    let removeCalls = 0; let cancelCalls = 0;
    const uncertain = createCareService({ store: f.store, encryption: f.encryption, media: {
      async write() { throw new Error('synthetic lost provider response'); }, read: f.media.read,
      async remove() { removeCalls += 1; }
    }, mediaQuota: { ...quota, async cancel(input) { cancelCalls += 1; return quota.cancel(input); } } });
    const other = { ...asset, mediaId: 'uncertain-photo' };
    await assert.rejects(uncertain.upload('familyA', profile.id, other), error => error.code === 'MEDIA_UPLOAD_RECONCILIATION_REQUIRED');
    state = f.encryption.open(f.families[family.id].sealed, `family:${family.id}`).mediaQuota;
    assert.equal(state.reservedBytes, bytes.length);
    assert.equal(state.usedBytes, 0);
    assert.equal(removeCalls, 0);
    assert.equal(cancelCalls, 0);
  });
  it('recovers named file reservations after crashes without releasing or replacing a blob', async () => {
    const f = fixture(); const { profile, family } = await setup(f); await invite(f, profile.id, 'member', ['read']);
    const quota = createCareMediaQuota({ store: f.store, encryption: f.encryption,
      config: resolveCareMediaQuotaConfig({ CARE_FAMILY_MEDIA_QUOTA_BYTES: '64', CARE_FAMILY_MEDIA_QUOTA_MAX_FILES: '4' }) });
    const objects = {}; let namedWrites = 0;
    const media = {
      async writeNamed(name, value) { if (!objects[name]) { objects[name] = Buffer.from(value); namedWrites += 1; return { name, created: true }; } return { name, created: false }; },
      async read(name) { if (!objects[name]) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return objects[name]; },
      async remove(name) { delete objects[name]; }
    };
    const service = createCareService({ store: f.store, encryption: f.encryption, media, mediaQuota: quota });
    const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const makeAsset = (mediaId, visibility) => ({ mediaId, ...(visibility ? { visibility } : {}), data: bytes.toString('base64'), type: 'image/png', sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    const first = makeAsset('recover-after-reserve');
    const reserved = await quota.reserve({ familyId: family.id, profileId: profile.id, mediaId: first.mediaId, sha256: first.sha256, size: bytes.length, actor: 'familyA', owner: null, type: first.type });
    await service.upload('familyA', profile.id, first);
    assert.equal(namedWrites, 1);
    assert.equal((await service.download('familyA', profile.id, first.mediaId)).data, first.data);

    const second = makeAsset('recover-after-write');
    const written = await quota.reserve({ familyId: family.id, profileId: profile.id, mediaId: second.mediaId, sha256: second.sha256, size: bytes.length, actor: 'familyA', owner: null, type: second.type });
    objects[written.reservation.objectName] = Buffer.from(JSON.stringify(f.encryption.seal({ data: second.data }, `media:${profile.id}:${second.mediaId}`)));
    await service.upload('familyA', profile.id, second);
    assert.equal(namedWrites, 1);

    const revoked = makeAsset('revoked-recovery');
    const revokedReservation = await quota.reserve({ familyId: family.id, profileId: profile.id, mediaId: revoked.mediaId, sha256: revoked.sha256, size: bytes.length, actor: 'member', owner: null, type: revoked.type });
    await f.service.command('familyA', profile.id, { action: 'grant', operationId: newId(), member: 'member', permissions: [] });
    await assert.rejects(service.upload('member', profile.id, revoked), error => error.code === 'PROFILE_ACCESS_DENIED');
    assert.equal(objects[revokedReservation.reservation.objectName], undefined);

    const mismatch = makeAsset('metadata-mismatch', 'private');
    await quota.reserve({ familyId: family.id, profileId: profile.id, mediaId: mismatch.mediaId, sha256: mismatch.sha256, size: bytes.length, actor: 'familyA', owner: null, type: mismatch.type });
    await assert.rejects(service.upload('familyA', profile.id, mismatch), error => error.code === 'MEDIA_ID_REUSED');
    const quotaState = f.encryption.open(f.families[family.id].sealed, `family:${family.id}`).mediaQuota;
    assert.equal(quotaState.reservedBytes, bytes.length * 2);
  });
  it('retains pending media and queued references when media registration returns 409 or 503', async () => {
    const f = fixture(); const { profile, family } = await setup(f); await invite(f, profile.id, 'therapist');
    const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    for (const status of [409, 503]) {
      const disk = {}; const calls = []; const mediaId = `retry-media-${status}`;
      const request = async (path, method, body) => {
        calls.push({ path, method });
        if (method === 'GET') return f.service.snapshot('therapist', profile.id);
        if (path.endsWith('/media')) {
          const error = new Error('synthetic media retry');
          error.status = status; error.data = { code: status === 409 ? 'MEDIA_UPLOAD_PENDING_RECONCILIATION' : 'MEDIA_UPLOAD_RECONCILIATION_REQUIRED' };
          throw error;
        }
        throw new Error('a media failure must stop before commands POST');
      };
      const client = createCareSync({ accountId: 'therapist', familyId: family.id, profileId: profile.id,
        storage: { get: async key => disk[key], set: async (key, value) => { disk[key] = value; } }, request, newId, currentAccount: () => 'therapist' });
      await client.init(); await client.sync();
      await client.addMedia({ mediaId, type: 'image/png', data: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      await client.edit('tile', `retry-tile-${status}`, { mediaId });
      await assert.rejects(client.sync(), error => error.status === status);
      assert.equal(client.archive().media[mediaId].pending, true);
      assert.equal(client.archive().queue.length, 1);
      assert.equal(calls.filter(call => call.path.endsWith('/commands') && call.method === 'POST').length, 0);
    }
  });
  it('persists offline edits across restart, recovers a lost response, resolves conflicts and locks revoked clients', async () => {
    const f = fixture(); const { profile, family } = await setup(f); await invite(f, profile.id, 'therapist');
    const disk = {}; let offline = false, loseResponse = false, actor = 'therapist';
    const request = async (path, method, body) => {
      if (offline) throw new Error('offline');
      if (method === 'GET') return f.service.snapshot(actor, profile.id);
      const result = await f.service.command(actor, profile.id, body);
      if (loseResponse) { loseResponse = false; throw new Error('response lost'); } return result;
    };
    const options = { accountId: 'therapist', familyId: family.id, profileId: profile.id,
      storage: { get: async k => disk[k], set: async (k, v) => { disk[k] = v; } }, request, newId, currentAccount: () => actor };
    let client = createCareSync(options); await client.init(); await client.sync();
    offline = true; await client.edit('tile', 'one', { label: '离线修改' }); await assert.rejects(client.sync());
    client = createCareSync(options); await client.init(); assert.equal(client.view().queue.length, 1);
    offline = false; loseResponse = true; await assert.rejects(client.sync()); await client.sync();
    assert.equal(client.view().queue.length, 0); assert.equal((await f.service.snapshot(actor, profile.id)).resources.length, 1);
    offline = true; await client.edit('tile', 'one', { label: '本机第二版' });
    await f.service.command('familyA', profile.id, command('one', { label: '家属修改' }, 1));
    offline = false; await client.sync(); assert.equal(client.view().conflicts.length, 1);
    await client.resolve(client.view().conflicts[0].operation.operationId, 'local'); await client.sync();
    assert.equal((await f.service.snapshot(actor, profile.id)).resources[0].value.label, '本机第二版');
    await client.edit('tile', 'two', { label: '撤权前排队' });
    await f.service.command('familyA', profile.id, { action: 'grant', operationId: newId(), member: actor, permissions: [] });
    await assert.rejects(client.sync(), e => e.status === 403); assert(client.view().locked);
    assert.equal(Object.keys(client.view().resources).length, 0);
    actor = 'other'; assert.throws(() => client.view());
  });
});

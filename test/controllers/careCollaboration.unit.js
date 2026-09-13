'use strict';
const assert = require('assert').strict;
const crypto = require('crypto');
const { createCareService } = require('../../api/helpers/careService');
const { createCareCrypto } = require('../../api/helpers/careCrypto');
const { createCareSync } = require('../../../cboard/src/common/communicationSupport/careSync');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const newId = () => crypto.randomBytes(16).toString('hex');
function fixture() {
  const families = {}, profiles = {}, blobs = {};
  const keys = { test: crypto.randomBytes(32).toString('hex') };
  const encryption = createCareCrypto(keys, 'test');
  const store = {
    createFamily: async d => { families[d._id] = clone(d); },
    getFamily: async id => clone(families[id]),
    listFamilies: async u => clone(Object.values(families).filter(f => f.owner === u)),
    createCommunicator: async () => {},
    createProfile: async d => { profiles[d._id] = clone(d); },
    getProfile: async id => clone(profiles[id]),
    listProfiles: async u => clone(Object.values(profiles).filter(p => p.members.includes(u))),
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

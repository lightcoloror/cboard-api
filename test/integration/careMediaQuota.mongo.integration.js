'use strict';
// Explicit isolated Mongo/file-media acceptance only. This test never starts
// HTTP, never falls back to a default database, and never touches Azure.
const assert = require('assert').strict;
const crypto = require('crypto');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function main() {
  const uri = process.env.CARE_TEST_MONGO_URI;
  if (!uri || !/^mongodb:\/\/[^/]+\/care_test_[a-f0-9]+$/.test(uri)) {
    throw new Error('Explicit isolated care_test database required');
  }
  const databaseName = uri.split('/').pop();
  const tempBase = path.resolve(process.env.TEST_TMP_ROOT || os.tmpdir(), databaseName);
  const mediaRoot = path.join(tempBase, 'care-media-quota');
  process.env.CARE_ENCRYPTION_ACTIVE_KEY = 'test';
  process.env.CARE_ENCRYPTION_KEYS = JSON.stringify({ test: crypto.randomBytes(32).toString('hex') });
  await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  try {
    const { Family, Profile } = require('../../api/models/CareWorkspace');
    const { store } = require('../../api/helpers/careRuntime');
    const { createCareCrypto } = require('../../api/helpers/careCrypto');
    const { createCareFileMedia } = require('../../api/helpers/careFileMedia');
    const { createCareMediaQuota, resolveCareMediaQuotaConfig } = require('../../api/helpers/careMediaQuota');
    const { createCareService } = require('../../api/helpers/careService');
    const encryption = createCareCrypto(JSON.parse(process.env.CARE_ENCRYPTION_KEYS), 'test');
    const fileMedia = createCareFileMedia(mediaRoot);
    let failRemove = false; let writeBarrier = null;
    const media = {
      async write(value) {
        if (writeBarrier) { const barrier = writeBarrier; writeBarrier = null; barrier.started(); await barrier.release; }
        return fileMedia.write(value);
      },
      read: fileMedia.read,
      async remove(name) { if (failRemove) { failRemove = false; throw new Error('synthetic physical delete failure'); } return fileMedia.remove(name); }
    };
    const asset = mediaId => ({ mediaId, data: png.toString('base64'), sha256: digest(png), type: 'image/png' });

    // File-count limit: a third 12-byte object remains below 100 bytes but
    // exceeds the two-file allowance.
    const fileQuota = createCareMediaQuota({ store, encryption,
      config: resolveCareMediaQuotaConfig({ CARE_FAMILY_MEDIA_QUOTA_BYTES: '100', CARE_FAMILY_MEDIA_QUOTA_MAX_FILES: '2' }) });
    const fileService = createCareService({ store, encryption, media, mediaQuota: fileQuota });
    const family = await fileService.createFamily('owner', { name: '合成文件数家庭' });
    const first = await fileService.createProfile('owner', { familyId: family.id, name: '合成档案一' });
    const second = await fileService.createProfile('owner', { familyId: family.id, name: '合成档案二' });
    await fileService.upload('owner', first.id, asset('one'));
    await fileService.upload('owner', second.id, asset('two'));
    await assert.rejects(fileService.upload('owner', first.id, asset('three')), error => error.code === 'FAMILY_MEDIA_QUOTA_EXCEEDED');
    let state = encryption.open((await Family.findById(family.id).lean().exec()).sealed, `family:${family.id}`).mediaQuota;
    assert.equal(state.usedBytes, png.length * 2); assert.equal(state.usedFiles, 2);

    failRemove = true;
    await assert.rejects(fileService.deleteMedia('owner', first.id, 'one'));
    state = encryption.open((await Family.findById(family.id).lean().exec()).sealed, `family:${family.id}`).mediaQuota;
    assert.equal(state.usedBytes, png.length * 2);
    await fileService.deleteMedia('owner', first.id, 'one');
    await fileService.upload('owner', first.id, asset('three'));
    assert.equal((await fileService.download('owner', first.id, 'three')).data, asset('three').data);

    // Byte limit: three files are allowed, but a third 12-byte payload would
    // exceed 25 bytes. This proves bytes separately from the file-count case.
    const byteQuota = createCareMediaQuota({ store, encryption,
      config: resolveCareMediaQuotaConfig({ CARE_FAMILY_MEDIA_QUOTA_BYTES: '25', CARE_FAMILY_MEDIA_QUOTA_MAX_FILES: '3' }) });
    const byteService = createCareService({ store, encryption, media, mediaQuota: byteQuota });
    const byteFamily = await byteService.createFamily('byte-owner', { name: '合成字节家庭' });
    const byteFirst = await byteService.createProfile('byte-owner', { familyId: byteFamily.id, name: '合成字节档案一' });
    const byteSecond = await byteService.createProfile('byte-owner', { familyId: byteFamily.id, name: '合成字节档案二' });
    await byteService.upload('byte-owner', byteFirst.id, asset('byte-one'));
    await byteService.upload('byte-owner', byteSecond.id, asset('byte-two'));
    await assert.rejects(byteService.upload('byte-owner', byteFirst.id, asset('byte-three')), error => error.code === 'FAMILY_MEDIA_QUOTA_EXCEEDED');

    const concurrentFamily = await fileService.createFamily('owner-two', { name: '合成并发家庭' });
    const concurrentProfile = await fileService.createProfile('owner-two', { familyId: concurrentFamily.id, name: '合成并发档案' });
    let allowFirstWrite; let signalFirstWrite;
    const firstWriteGate = new Promise(resolve => { signalFirstWrite = resolve; });
    writeBarrier = { release: new Promise(resolve => { allowFirstWrite = resolve; }), started: signalFirstWrite };
    const firstUpload = fileService.upload('owner-two', concurrentProfile.id, asset('same'));
    await firstWriteGate;
    await assert.rejects(fileService.upload('owner-two', concurrentProfile.id, asset('same')), error => error.code === 'MEDIA_UPLOAD_PENDING_RECONCILIATION');
    allowFirstWrite(); await firstUpload;
    const beforeRetry = (await fs.readdir(mediaRoot)).length;
    assert.equal((await fileService.upload('owner-two', concurrentProfile.id, asset('same'))).reused, true);
    assert.equal((await fs.readdir(mediaRoot)).length, beforeRetry);
    assert.equal((await fileService.download('owner-two', concurrentProfile.id, 'same')).data, asset('same').data);

    // Named-file recovery uses a separate family so the old random-write
    // wrapper above retains its original five-scenario semantics.
    const namedQuota = createCareMediaQuota({ store, encryption,
      config: resolveCareMediaQuotaConfig({ CARE_FAMILY_MEDIA_QUOTA_BYTES: '100', CARE_FAMILY_MEDIA_QUOTA_MAX_FILES: '4' }) });
    const namedSetup = createCareService({ store, encryption, media: fileMedia, mediaQuota: namedQuota });
    const namedFamily = await namedSetup.createFamily('named-owner', { name: '合成恢复家庭' });
    const namedProfile = await namedSetup.createProfile('named-owner', { familyId: namedFamily.id, name: '合成恢复档案' });
    const canonicalCount = async () => (await fs.readdir(mediaRoot)).filter(name => /^[a-f0-9]{48}\.bin$/.test(name)).length;
    let rejectProfileCas = true;
    const interruptedStore = { ...store, casProfile: async (...args) => rejectProfileCas ? false : store.casProfile(...args) };
    const interruptedService = createCareService({ store: interruptedStore, encryption, media: fileMedia, mediaQuota: namedQuota });
    const afterPublish = asset('recover-after-publish');
    const beforePublish = await canonicalCount();
    await assert.rejects(interruptedService.upload('named-owner', namedProfile.id, afterPublish), error => error.code === 'MEDIA_UPLOAD_RECONCILIATION_REQUIRED');
    assert.equal(await canonicalCount(), beforePublish + 1);
    rejectProfileCas = false;
    const rebuiltService = createCareService({ store, encryption, media: fileMedia, mediaQuota: namedQuota });
    await rebuiltService.upload('named-owner', namedProfile.id, afterPublish);
    assert.equal(await canonicalCount(), beforePublish + 1);
    assert.equal((await rebuiltService.download('named-owner', namedProfile.id, afterPublish.mediaId)).data, afterPublish.data);

    const afterReserve = asset('recover-after-reserve');
    const pending = await namedQuota.reserve({ familyId: namedFamily.id, profileId: namedProfile.id, mediaId: afterReserve.mediaId,
      sha256: afterReserve.sha256, size: png.length, actor: 'named-owner', owner: null, type: afterReserve.type });
    assert.equal((await fs.readdir(mediaRoot)).includes(pending.reservation.objectName), false);
    const beforeReserveRecovery = await canonicalCount();
    await rebuiltService.upload('named-owner', namedProfile.id, afterReserve);
    assert.equal(await canonicalCount(), beforeReserveRecovery + 1);
    assert.equal((await rebuiltService.download('named-owner', namedProfile.id, afterReserve.mediaId)).data, afterReserve.data);

    let failCommitOnce = true;
    const commitInterrupted = createCareService({ store, encryption, media: fileMedia, mediaQuota: { ...namedQuota,
      async commit(input) { if (failCommitOnce) { failCommitOnce = false; const error = new Error('synthetic commit interruption'); error.code = 'COMMIT_INTERRUPTED'; throw error; } return namedQuota.commit(input); } } });
    const afterRegistration = asset('recover-after-registration');
    const beforeCommitRecovery = await canonicalCount();
    await assert.rejects(commitInterrupted.upload('named-owner', namedProfile.id, afterRegistration), error => error.code === 'COMMIT_INTERRUPTED');
    assert.equal(await canonicalCount(), beforeCommitRecovery + 1);
    assert.equal((await rebuiltService.upload('named-owner', namedProfile.id, afterRegistration)).reused, true);
    assert.equal(await canonicalCount(), beforeCommitRecovery + 1);
    assert.equal((await rebuiltService.download('named-owner', namedProfile.id, afterRegistration.mediaId)).data, afterRegistration.data);

    // An old writer can be paused after reserve while a recovery writer
    // registers and deletes the same identity. The deletion marker must stop
    // the old writer from recreating an uncharged canonical object.
    let releaseOldWriter; let oldWriterStarted;
    const oldWriterGate = new Promise(resolve => { releaseOldWriter = resolve; });
    const oldWriterReady = new Promise(resolve => { oldWriterStarted = resolve; });
    const oldWriterMedia = { ...fileMedia, async writeNamed(name, value) { oldWriterStarted(); await oldWriterGate; return fileMedia.writeNamed(name, value); } };
    const oldWriterService = createCareService({ store, encryption, media: oldWriterMedia, mediaQuota: namedQuota });
    const deletedDuringRecovery = asset('deleted-during-recovery');
    const oldWriter = oldWriterService.upload('named-owner', namedProfile.id, deletedDuringRecovery);
    await oldWriterReady;
    await rebuiltService.upload('named-owner', namedProfile.id, deletedDuringRecovery);
    await rebuiltService.deleteMedia('named-owner', namedProfile.id, deletedDuringRecovery.mediaId);
    await assert.rejects(rebuiltService.download('named-owner', namedProfile.id, deletedDuringRecovery.mediaId), error => error.code === 'MEDIA_NOT_FOUND');
    releaseOldWriter();
    await assert.rejects(oldWriter, error => error.code === 'MEDIA_UPLOAD_RECONCILIATION_REQUIRED');
    await assert.rejects(rebuiltService.upload('named-owner', namedProfile.id, deletedDuringRecovery), error => error.code === 'MEDIA_ID_REUSED');
    const deletedState = encryption.open((await store.getProfile(namedProfile.id)).sealed, `profile:${namedProfile.id}`);
    const deletedBlob = deletedState.media[deletedDuringRecovery.mediaId].blob;
    await assert.rejects(fs.access(path.join(mediaRoot, deletedBlob)), error => error.code === 'ENOENT');
    await fs.access(path.join(mediaRoot, `${deletedBlob}.deleted`));
    const deletedReservation = await namedQuota.reserve({ familyId: namedFamily.id, profileId: namedProfile.id, mediaId: 'deleted-during-recovery',
      sha256: deletedDuringRecovery.sha256, size: png.length, actor: 'named-owner', owner: null, type: deletedDuringRecovery.type }).catch(error => error);
    assert.equal(deletedReservation.code, 'MEDIA_ID_REUSED');
    state = encryption.open((await Family.findById(namedFamily.id).lean().exec()).sealed, `family:${namedFamily.id}`).mediaQuota;
    assert.equal(state.usedBytes, png.length * 3); assert.equal(state.reservedBytes, 0);

    // Existing media is scanned only when a family has no quota state; this
    // proves conservative counting, not a tool that repairs legacy storage.
    await Family.create({ _id: 'legacy-family', owner: 'legacy-owner', rev: 0,
      sealed: encryption.seal({ name: 'legacy', subscription: null }, 'family:legacy-family') });
    await Profile.create({ _id: 'legacy-profile', familyId: 'legacy-family', owner: 'legacy-owner', members: ['legacy-owner'], rev: 0,
      sealed: encryption.seal({ name: 'legacy', grants: { 'legacy-owner': ['read'] }, resources: {}, media: { old: { blob: 'unverified.bin', size: 7, sha256: digest('old'), deleted: true } } }, 'profile:legacy-profile') });
    const legacy = await fileQuota.ensureInitialized('legacy-family');
    assert.equal(legacy.quota.usedBytes, 7); assert.equal(legacy.quota.usedFiles, 1);
    console.log(JSON.stringify({ result: 'passed', careMediaQuotaMongo: true, realMongoCas: true, realFileMedia: true,
      scenarios: ['family-byte-limit', 'family-file-limit', 'concurrent-pending-and-completed-retry', 'delete-failure-retry', 'legacy-conservative-initialization', 'named-reserve-publish-registration-recovery', 'deleted-writer-fenced'],
      namedFileRetryRecovery: true, generalReconciliationTool: false, syntheticOnly: true, productionDatabaseTouched: false }));
  } finally {
    if (mongoose.connection.name !== databaseName) throw new Error('Cleanup database guard failed');
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
    if (path.dirname(mediaRoot) !== tempBase || path.basename(tempBase) !== databaseName || !databaseName.startsWith('care_test_')) {
      throw new Error('Cleanup media path guard failed');
    }
    await fs.rm(tempBase, { recursive: true, force: true });
  }
}
main().catch(async error => { console.error(error.name, error.code || error.message); await mongoose.disconnect(); process.exitCode = 1; });

'use strict';
// Only synthetic, empty, uniquely named databases supplied by the isolated runner.
const assert = require('assert').strict;
const mongoose = require('mongoose');
const { createCareFamilyLifecycle } = require('../../api/helpers/careFamilyLifecycle');

async function main() {
  const uri = process.env.CARE_TEST_MONGO_URI;
  if (!/^mongodb:\/\/[^/]+\/care_test_[a-f0-9]+$/.test(uri || '')) throw new Error('Explicit isolated database required');
  const name = uri.split('/').pop();
  await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  const connection = mongoose.connection;
  const families = connection.db.collection('carefamilies');
  const profiles = connection.db.collection('careprofiles');
  const accounts = connection.db.collection('careaccountlifecycles');
  assert.equal((await connection.db.listCollections().toArray()).length, 0, 'must use an empty isolated database');
  await connection.db.createCollection('carefamilies');
  await connection.db.createCollection('careprofiles');
  await connection.db.createCollection('careaccountlifecycles');
  await connection.db.createCollection('careaccounts');
  await connection.db.createCollection('communicators');
  process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
  const runtimeStore = require('../../api/helpers/careRuntime').store;
  const dependencies = { connection, Family: { collection: families }, Profile: { collection: profiles }, AccountLifecycle: { collection: accounts } };
  const service = createCareFamilyLifecycle(dependencies);
  const seed = async suffix => {
    const owner = `owner-${suffix}`, familyId = `family-${suffix}`, profileId = `profile-${suffix}`;
    await families.insertOne({ _id: familyId, owner, rev: 0, sealed: { synthetic: true } });
    await profiles.insertOne({ _id: profileId, familyId, owner, members: [owner], rev: 0 });
    return { owner, familyId, profileId };
  };
  const passed = [];
  try {
    const a = await seed('solo');
    await assert.rejects(service.beginClose(a.owner, []), e => e.code === 'FAMILY_CLOSE_CONFIRMATION_REQUIRED');
    assert.equal((await families.findOne({ _id: a.familyId })).lifecycleRev, undefined);
    assert.equal(await accounts.findOne({ _id: a.owner }), null, 'preview must roll back a newly created account gate');
    passed.push('confirmation-preview-has-no-writes');

    const b = await seed('rollback');
    await assert.rejects(service.withOpenFamily(b.familyId, async session => {
      await profiles.updateOne({ _id: b.profileId }, { $inc: { rev: 1 } }, { session });
      throw new Error('synthetic rollback');
    }), /synthetic rollback/);
    assert.equal((await profiles.findOne({ _id: b.profileId })).rev, 0);
    assert.equal((await families.findOne({ _id: b.familyId })).lifecycleRev, undefined);
    assert.equal(await service.withOpenFamily(b.familyId, async session => {
      await profiles.updateOne({ _id: b.profileId }, { $inc: { rev: 1 } }, { session });
      return 'business-result';
    }), 'business-result');
    passed.push('atomic-rollback-and-callback-result');

    const c = await seed('race');
    let writerEntered, closeAttempted;
    const entered = new Promise(resolve => { writerEntered = resolve; });
    const attempted = new Promise(resolve => { closeAttempted = resolve; });
    const observedCollection = {
      find: (...args) => families.find(...args),
      findOne: (...args) => families.findOne(...args),
      updateOne: (filter, update, options) => {
        if (update.$set && update.$set.closure) closeAttempted();
        return families.updateOne(filter, update, options);
      }
    };
    const closer = createCareFamilyLifecycle({ ...dependencies, Family: { collection: observedCollection } });
    const writer = service.withOpenFamily(c.familyId, async session => {
      writerEntered();
      await attempted;
      await profiles.updateOne({ _id: c.profileId }, { $addToSet: { members: 'new-member' } }, { session });
    });
    await entered;
    const closing = assert.rejects(closer.beginClose(c.owner, [c.familyId]), e => e.code === 'FAMILY_TRANSFER_REQUIRED');
    await Promise.all([writer, closing]);
    assert.equal((await families.findOne({ _id: c.familyId })).closure, undefined);
    assert((await profiles.findOne({ _id: c.profileId })).members.includes('new-member'));
    passed.push('concurrent-writer-forces-close-revalidation');

    const d = await seed('new-family-race');
    // Establish the account document before exercising a concurrent family
    // insert, so the test specifically measures the shared account write fence.
    await service.withOpenAccount(d.owner, async () => true);
    let creatingEntered, accountCloseAttempted;
    const creating = new Promise(resolve => { creatingEntered = resolve; });
    const accountAttempt = new Promise(resolve => { accountCloseAttempted = resolve; });
    const observedAccounts = {
      findOne: (...args) => accounts.findOne(...args),
      updateOne: (...args) => { accountCloseAttempted(); return accounts.updateOne(...args); }
    };
    const accountCloser = createCareFamilyLifecycle({ ...dependencies, AccountLifecycle: { collection: observedAccounts } });
    const newFamily = { _id: 'family-concurrent-new', owner: d.owner, sealed: { synthetic: true } };
    const insert = service.withOpenAccount(d.owner, async session => {
      creatingEntered();
      await accountAttempt;
      await families.insertOne(newFamily, { session });
    });
    await creating;
    const accountClose = assert.rejects(accountCloser.beginClose(d.owner, [d.familyId]), error =>
      error.code === 'FAMILY_CLOSE_CONFIRMATION_REQUIRED' && error.details.familyIds.includes(newFamily._id));
    await Promise.all([insert, accountClose]);
    assert.equal((await accounts.findOne({ _id: d.owner })).closure, undefined);
    assert.equal((await families.findOne({ _id: d.familyId })).closure, undefined);
    passed.push('new-family-insert-forces-fresh-confirmation');

    const initialFamilies = ['family-first-one', 'family-first-two'].map(_id => ({ _id, owner: 'owner-first', sealed: { synthetic: true } }));
    const initialResults = await Promise.allSettled(initialFamilies.map(value => service.createFamily(value)));
    assert(initialResults.some(result => result.status === 'fulfilled'));
    for (let i = 0; i < initialResults.length; i++) {
      if (initialResults[i].status === 'rejected') {
        assert.equal(initialResults[i].reason.code, 'ACCOUNT_CLOSE_CONFLICT');
        assert.equal(await families.findOne({ _id: initialFamilies[i]._id }), null);
        await service.createFamily(initialFamilies[i]);
      }
    }
    assert.equal(await families.countDocuments({ owner: 'owner-first' }), 2);
    assert.equal((await accounts.findOne({ _id: 'owner-first' })).status, 'open');
    passed.push('concurrent-first-account-gate-is-safe-to-retry');

    const result = await service.beginClose(a.owner, [a.familyId]);
    assert.equal(result.status, 'closing');
    assert.deepEqual(result.familyIds, [a.familyId]);
    let lateWriterCalled = false;
    await assert.rejects(service.withOpenFamily(a.familyId, async () => { lateWriterCalled = true; }), e => e.code === 'FAMILY_CLOSING');
    assert.equal(lateWriterCalled, false);
    await assert.rejects(service.createFamily({ _id: 'family-too-late', owner: a.owner, sealed: { synthetic: true } }),
      error => error.code === 'ACCOUNT_CLOSING');
    assert.equal(await families.findOne({ _id: 'family-too-late' }), null);
    assert.equal((await families.findOne({ _id: a.familyId })).sealed.synthetic, true);
    assert.equal((await families.findOne({ _id: b.familyId })).closure, undefined);
    passed.push('close-blocks-late-writer-without-deleting-content');
    const transfer = await seed('transfer');
    await assert.rejects(service.casFamily(transfer.familyId, 0, { owner: a.owner, rev: 1 }),
      error => error.code === 'ACCOUNT_CLOSING');
    assert.equal((await families.findOne({ _id: transfer.familyId })).owner, transfer.owner);
    assert.equal(await accounts.findOne({ _id: transfer.owner }), null, 'failed transfer rolls back all gates');
    assert.equal(await service.casFamily(transfer.familyId, 0, { owner: 'owner-transfer-next', rev: 1 }), true);
    assert.equal(await service.casFamily(transfer.familyId, 0, { owner: transfer.owner, rev: 1 }), false);
    assert.equal((await families.findOne({ _id: transfer.familyId })).owner, 'owner-transfer-next');
    await assert.rejects(service.beginClose(transfer.owner, [transfer.familyId]),
      error => error.code === 'FAMILY_CLOSE_CONFIRMATION_REQUIRED');
    passed.push('ownership-transfer-fences-closing-account-and-stale-version');
    const source = await seed('transfer-race-source');
    const destination = await seed('transfer-race-destination');
    await service.withOpenAccount(source.owner, async () => true);
    await service.withOpenAccount(destination.owner, async () => true);
    let transferReady, closeLockAttempt;
    const ready = new Promise(resolve => { transferReady = resolve; });
    const lockAttempt = new Promise(resolve => { closeLockAttempt = resolve; });
    const transferService = createCareFamilyLifecycle({ ...dependencies, Family: { collection: {
      findOne: (...args) => families.findOne(...args),
      updateOne: async (...args) => {
        transferReady();
        await lockAttempt;
        return families.updateOne(...args);
      }
    } } });
    const destinationCloser = createCareFamilyLifecycle({ ...dependencies, AccountLifecycle: { collection: {
      findOne: (...args) => accounts.findOne(...args),
      updateOne: (...args) => { closeLockAttempt(); return accounts.updateOne(...args); }
    } } });
    const transferring = transferService.casFamily(source.familyId, 0, { owner: destination.owner, rev: 1 });
    await ready;
    const destinationClosing = assert.rejects(destinationCloser.beginClose(destination.owner, [destination.familyId]),
      error => error.code === 'FAMILY_CLOSE_CONFIRMATION_REQUIRED' && error.details.familyIds.includes(source.familyId));
    await Promise.all([transferring, destinationClosing]);
    assert.equal((await accounts.findOne({ _id: destination.owner })).status, 'open');
    assert.equal((await families.findOne({ _id: source.familyId })).owner, destination.owner);
    passed.push('concurrent-transfer-forces-new-owner-close-reconfirmation');
    await assert.rejects(service.casProfile(a.profileId, 0, { rev: 1, members: [a.owner, 'late-member'] }),
      error => error.code === 'FAMILY_CLOSING');
    assert.equal((await profiles.findOne({ _id: a.profileId })).rev, 0);
    const profileRace = await seed('profile-write-race');
    await service.withOpenAccount(profileRace.owner, async () => true);
    let profileWriterReady, profileCloseAttempt;
    const profileReady = new Promise(resolve => { profileWriterReady = resolve; });
    const profileAttempt = new Promise(resolve => { profileCloseAttempt = resolve; });
    const profileWriter = createCareFamilyLifecycle({ ...dependencies, Profile: { collection: {
      findOne: (...args) => profiles.findOne(...args),
      updateOne: async (...args) => {
        profileWriterReady();
        await profileAttempt;
        return profiles.updateOne(...args);
      }
    } } });
    const profileCloser = createCareFamilyLifecycle({ ...dependencies, AccountLifecycle: { collection: {
      findOne: (...args) => accounts.findOne(...args),
      updateOne: (...args) => { profileCloseAttempt(); return accounts.updateOne(...args); }
    } } });
    const profileWriting = profileWriter.casProfile(profileRace.profileId, 0, {
      rev: 1, members: [profileRace.owner, 'accepted-member'], sealed: { synthetic: 'updated' }
    });
    await profileReady;
    const profileClosing = assert.rejects(profileCloser.beginClose(profileRace.owner, [profileRace.familyId]),
      error => error.code === 'FAMILY_TRANSFER_REQUIRED');
    await Promise.all([profileWriting, profileClosing]);
    assert.equal((await accounts.findOne({ _id: profileRace.owner })).status, 'open');
    assert.equal((await profiles.findOne({ _id: profileRace.profileId })).sealed.synthetic, 'updated');
    assert.equal(await service.casProfile(profileRace.profileId, 0, { rev: 1, members: [profileRace.owner] }), false);
    passed.push('profile-cas-fences-close-and-revalidates-concurrent-membership');
    const personal = { _id: 'personal-account', rev: 0, sealed: { synthetic: 'personal' } };
    assert.equal(await runtimeStore.createAccount(personal), true);
    const gateBeforeDuplicate = await accounts.findOne({ _id: personal._id });
    assert.equal(await runtimeStore.createAccount(personal), false);
    assert.deepEqual(await accounts.findOne({ _id: personal._id }), gateBeforeDuplicate,
      'duplicate must abort the entire transaction, including lifecycle increment');
    assert.equal(await runtimeStore.casAccount(personal._id, 0, { rev: 1, sealed: { synthetic: 'changed' } }), true);
    assert.equal(await runtimeStore.casAccount(personal._id, 0, { rev: 1, sealed: { synthetic: 'stale' } }), false);
    await assert.rejects(runtimeStore.createAccount({ _id: a.owner, rev: 0, sealed: { synthetic: true } }),
      error => error.code === 'ACCOUNT_CLOSING');
    await assert.rejects(runtimeStore.casAccount(a.owner, 0, { rev: 1 }), error => error.code === 'ACCOUNT_CLOSING');
    assert.equal(await connection.db.collection('careaccounts').findOne({ _id: a.owner }), null);
    passed.push('runtime-personal-account-cas-and-duplicate-rollback');

    const creation = await seed('profile-create');
    const newProfile = { _id: 'profile-created-atomic', familyId: creation.familyId, owner: creation.owner,
      members: [creation.owner], rev: 0, sealed: { synthetic: true } };
    await runtimeStore.createProfileWithCommunicator(newProfile);
    assert.equal((await profiles.findOne({ _id: newProfile._id })).familyId, creation.familyId);
    assert.equal(await connection.db.collection('communicators').countDocuments({ careProfileId: newProfile._id }), 1);
    await assert.rejects(runtimeStore.createProfileWithCommunicator(newProfile), error => error.code === 11000);
    assert.equal(await connection.db.collection('communicators').countDocuments({ careProfileId: newProfile._id }), 1,
      'profile duplicate must roll back the preceding communicator insert');
    await assert.rejects(runtimeStore.createProfileWithCommunicator({ ...newProfile, _id: 'profile-late-create',
      familyId: a.familyId, owner: a.owner, members: [a.owner] }), error => error.code === 'FAMILY_CLOSING');
    assert.equal(await connection.db.collection('communicators').countDocuments({ careProfileId: 'profile-late-create' }), 0);
    assert.equal(await profiles.findOne({ _id: 'profile-late-create' }), null);
    assert.equal(await runtimeStore.casProfile(newProfile._id, 0, { rev: 1, members: [creation.owner] },
      { expectedOwner: 'stale-owner' }), false);
    assert.equal((await profiles.findOne({ _id: newProfile._id })).rev, 0);
    passed.push('runtime-profile-create-is-atomic-and-preserves-owner-authorization');
    // Fresh synthetic encryption key exists only for this isolated fixture.
    process.env.CARE_ENCRYPTION_ACTIVE_KEY = 'synthetic';
    process.env.CARE_ENCRYPTION_KEYS = JSON.stringify({ synthetic: require('crypto').randomBytes(32).toString('hex') });
    const encryption = require('../../api/helpers/careCrypto').fromEnvironment();
    await connection.db.createCollection('carefundings');
    const fundingRuntime = require('../../api/helpers/careBudgetRuntime');
    const budget = fundingRuntime.createRuntime();
    const budgetFamily = await seed('budget');
    const startsAt = Date.now() - 1000, expiresAt = Date.now() + 86400000;
    await families.updateOne({ _id: budgetFamily.familyId }, { $set: {
      sealed: encryption.seal({ subscription: { startsAt, expiresAt } }, `family:${budgetFamily.familyId}`)
    } });
    await profiles.updateOne({ _id: budgetFamily.profileId }, { $set: {
      sealed: encryption.seal({ grants: { [budgetFamily.owner]: ['read'] } }, `profile:${budgetFamily.profileId}`)
    } });
    await budget.provision('budget-family-funding', { owner: budgetFamily.owner, familyId: budgetFamily.familyId,
      kind: 'family', startsAt, expiresAt, weeklyLimit: 100 });
    await budget.addPack('budget-family-funding', { id: 'before-close-pack', type: 'purchased', amount: 5, startsAt });
    const usage = { actor: budgetFamily.owner, profileId: budgetFamily.profileId, requestId: 'before-close',
      units: 10, fingerprint: 'a'.repeat(64) };
    await budget.reserve('budget-family-funding', usage);
    await service.beginClose(budgetFamily.owner, [budgetFamily.familyId]);
    await assert.rejects(budget.reserve('budget-family-funding', { ...usage, requestId: 'after-close' }),
      error => error.code === 'FAMILY_CLOSING');
    const settled = await budget.settle('budget-family-funding', budgetFamily.owner, usage.requestId, 4);
    assert.equal(settled.status, 'settled');
    assert.equal((await budget.settle('budget-family-funding', budgetFamily.owner, usage.requestId, 4)).actual, 4);
    const fundingState = encryption.open((await fundingRuntime.store.get('budget-family-funding')).sealed, 'funding:budget-family-funding');
    assert.equal(fundingState.weekUsed['0'], 4);
    assert.equal(fundingState.receipts[`${budgetFamily.owner}:after-close`], undefined);
    await assert.rejects(budget.addPack('budget-family-funding', { id: 'late-pack', type: 'purchased', amount: 5, startsAt }),
      error => error.code === 'FAMILY_CLOSING');
    passed.push('family-close-blocks-new-budget-writes-but-preserves-settlement');

    await budget.provision('institution-funding', { owner: 'institution-owner', kind: 'institution', startsAt, expiresAt, weeklyLimit: 100 });
    await budget.delegate('institution-funding', 'institution-owner', { member: budgetFamily.owner, limit: 20, profileIds: [budgetFamily.profileId] });
    await assert.rejects(budget.reserve('institution-funding', { ...usage, requestId: 'institution-closed-profile' }),
      error => error.code === 'FAMILY_CLOSING');
    const otherFamily = await seed('other-budget');
    await families.updateOne({ _id: otherFamily.familyId }, { $set: {
      sealed: encryption.seal({ subscription: { startsAt, expiresAt } }, `family:${otherFamily.familyId}`)
    } });
    await profiles.updateOne({ _id: otherFamily.profileId }, { $set: {
      sealed: encryption.seal({ grants: { [otherFamily.owner]: ['read'] } }, `profile:${otherFamily.profileId}`)
    } });
    await budget.delegate('institution-funding', 'institution-owner', { member: otherFamily.owner, limit: 20, profileIds: [otherFamily.profileId] });
    assert.equal((await budget.reserve('institution-funding', { ...usage, actor: otherFamily.owner,
      profileId: otherFamily.profileId, requestId: 'institution-open-profile' })).status, 'reserved');
    passed.push('institution-budget-checks-patient-family-without-locking-other-families');
    await connection.db.createCollection('careclosurejobs');
    const careAccounts = connection.db.collection('careaccounts');
    // Earlier account CAS cases used a marker payload; normalize it before
    // exercising the real encrypted manifest scan of all personal accounts.
    await careAccounts.updateOne({ _id: personal._id }, { $set: { sealed: encryption.seal({}, `account:${personal._id}`) } });
    const jobFamily = await seed('closure-job');
    const blobName = `${'a'.repeat(48)}.bin`, pendingName = `${'b'.repeat(48)}.bin`;
    await families.updateOne({ _id: jobFamily.familyId }, { $set: { sealed: encryption.seal({
      subscription: { startsAt, expiresAt }, mediaQuota: { reservations: { uploadPending: {
        status: 'reserved', profileId: jobFamily.profileId, mediaId: 'pending-media', objectName: pendingName
      } } }
    }, `family:${jobFamily.familyId}`) } });
    await profiles.updateOne({ _id: jobFamily.profileId }, { $set: { sealed: encryption.seal({
      name: 'SYNTHETIC-PATIENT-NAME', grants: { [jobFamily.owner]: ['read'] },
      media: { image: { blob: blobName, size: 3, deleted: false } }
    }, `profile:${jobFamily.profileId}`) } });
    await careAccounts.insertOne({ _id: 'former-collaborator', rev: 0, sealed: encryption.seal({ favorites: {
      oldFavorite: { profileId: jobFamily.profileId, value: { sentence: 'SYNTHETIC-PRIVATE-SENTENCE' } }
    } }, 'account:former-collaborator') });
    await budget.provision('closing-family-funding', { owner: jobFamily.owner, familyId: jobFamily.familyId,
      kind: 'family', startsAt, expiresAt, weeklyLimit: 100 });
    await budget.reserve('closing-family-funding', { ...usage, actor: jobFamily.owner, profileId: jobFamily.profileId, requestId: 'job-family-pending' });
    await budget.delegate('institution-funding', 'institution-owner', { member: jobFamily.owner, limit: 20, profileIds: [jobFamily.profileId] });
    await budget.reserve('institution-funding', { ...usage, actor: jobFamily.owner, profileId: jobFamily.profileId, requestId: 'job-institution-pending' });
    const { createCareClosureCoordinator } = require('../../api/helpers/careClosureCoordinator');
    const coordinator = createCareClosureCoordinator({ connection, encryption });
    const prepared = await coordinator.begin(jobFamily.owner, [jobFamily.familyId]);
    const jobs = connection.db.collection('careclosurejobs');
    const job = await jobs.findOne({ _id: prepared.operationId });
    assert.equal(prepared.cleanupStatus, 'prepared');
    const plan = encryption.open(job.sealed, `closure:${prepared.operationId}`);
    assert.deepEqual(plan.familyFundingIds, ['closing-family-funding']);
    assert.equal(plan.pendingUsage.length, 2, 'include pending institution receipts owned by another administrator');
    assert.equal(plan.pendingUploads[0].objectName, pendingName);
    assert.deepEqual(plan.media.map(item => item.blob), [blobName]);
    assert(plan.relatedAccountIds.includes('former-collaborator'));
    assert(!JSON.stringify(plan).includes('SYNTHETIC-PRIVATE-SENTENCE'));
    assert(!JSON.stringify(plan).includes('SYNTHETIC-PATIENT-NAME'));
    assert(!JSON.stringify(job).includes(blobName));
    const beforeResume = await accounts.findOne({ _id: jobFamily.owner });
    const resumed = await createCareClosureCoordinator({ connection, encryption }).begin(jobFamily.owner, [jobFamily.familyId]);
    assert.equal(resumed.operationId, prepared.operationId);
    assert.deepEqual(await accounts.findOne({ _id: jobFamily.owner }), beforeResume);
    assert.equal(await jobs.countDocuments({ owner: jobFamily.owner }), 1);
    const status = await coordinator.inspect(jobFamily.owner, prepared.operationId);
    assert.equal(status.sealed, undefined);
    await assert.rejects(coordinator.inspect('unrelated-owner', prepared.operationId), error => error.code === 'CLOSURE_JOB_UNAVAILABLE');
    passed.push('closure-manifest-is-atomic-encrypted-scoped-and-resumable');

    const broken = await seed('broken-closure-plan');
    await assert.rejects(coordinator.begin(broken.owner, [broken.familyId]), error => error.code === 'CLOSURE_PLAN_UNAVAILABLE');
    assert.equal((await families.findOne({ _id: broken.familyId })).closure, undefined);
    assert.equal(await accounts.findOne({ _id: broken.owner }), null);
    assert.equal(await jobs.countDocuments({ owner: broken.owner }), 0);
    const bounded = await seed('bounded-closure-plan');
    await assert.rejects(createCareClosureCoordinator({ connection, encryption, maxScanRecords: 1 }).begin(bounded.owner, [bounded.familyId]),
      error => error.code === 'CLOSURE_SCAN_LIMIT_REACHED');
    assert.equal((await families.findOne({ _id: bounded.familyId })).closure, undefined);
    assert.equal(await accounts.findOne({ _id: bounded.owner }), null);
    passed.push('failed-or-incomplete-manifest-rolls-back-closing-state');
    console.log(JSON.stringify({ result: 'passed', realReplicaSet: true, cases: passed, syntheticOnly: true,
      httpClosureEnabled: false, externalMediaDeleted: false, accountCreationFenceVerified: true,
      allAccountWritersIntegrated: false }));
  } finally {
    if (connection.name !== name) throw new Error('Cleanup database guard failed');
    await connection.dropDatabase();
    await mongoose.disconnect();
  }
}
main().catch(async error => {
  console.error(error.stack);
  await mongoose.disconnect();
  process.exitCode = 1;
});

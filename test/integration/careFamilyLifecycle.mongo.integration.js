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

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
  assert.equal((await connection.db.listCollections().toArray()).length, 0, 'must use an empty isolated database');
  await connection.db.createCollection('carefamilies');
  await connection.db.createCollection('careprofiles');
  const service = createCareFamilyLifecycle({ connection, Family: { collection: families }, Profile: { collection: profiles } });
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
    const closer = createCareFamilyLifecycle({ connection, Family: { collection: observedCollection }, Profile: { collection: profiles } });
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

    const result = await service.beginClose(a.owner, [a.familyId]);
    assert.equal(result.status, 'closing');
    assert.deepEqual(result.familyIds, [a.familyId]);
    let lateWriterCalled = false;
    await assert.rejects(service.withOpenFamily(a.familyId, async () => { lateWriterCalled = true; }), e => e.code === 'FAMILY_CLOSING');
    assert.equal(lateWriterCalled, false);
    assert.equal((await families.findOne({ _id: a.familyId })).sealed.synthetic, true);
    assert.equal((await families.findOne({ _id: b.familyId })).closure, undefined);
    passed.push('close-blocks-late-writer-without-deleting-content');
    console.log(JSON.stringify({ result: 'passed', realReplicaSet: true, cases: passed, syntheticOnly: true,
      httpClosureEnabled: false, externalMediaDeleted: false, accountWideFenceVerified: false }));
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

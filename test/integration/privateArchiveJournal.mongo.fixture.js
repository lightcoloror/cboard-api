'use strict';

const assert = require('assert').strict;
const { createCommunicationPrivateLibraryController } = require('../../api/controllers/communicationPrivateLibrary');
const { createCareFamilyLifecycle } = require('../../api/helpers/careFamilyLifecycle');

const ARCHIVE_MAGIC = Buffer.from('PIE2EE01', 'ascii');

function response() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

module.exports = async function privateArchiveJournalMongoFixture({
  mongoose,
  passed,
  fileMedia,
  coordinator
}) {
  const previousFlag = process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
  process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
  const connection = mongoose.connection;
  const accountCollection = connection.db.collection('careaccountlifecycles');
  const journalCollection = connection.db.collection('privatearchiveuploads');
  const users = connection.db.collection('users');
  const lifecycle = createCareFamilyLifecycle({ connection });
  const archiveBuffer = Buffer.concat([ARCHIVE_MAGIC, Buffer.from('synthetic encrypted archive')]);
  const archiveModels = [
    { Model: require('../../api/models/CommunicationPrivateLibrary'), format: 'picinterpreter-private-picture-library-encrypted' },
    { Model: require('../../api/models/CommunicationPrivateDeviceData'), format: 'picinterpreter-private-device-data-encrypted' }
  ];

  async function seedUser() {
    const id = new mongoose.Types.ObjectId();
    const owner = String(id);
    await users.insertOne({
      _id: id,
      name: `Synthetic archive user ${owner}`,
      email: `archive-${owner}@example.test`,
      password: 'synthetic-password'
    });
    await accountCollection.updateOne(
      { _id: owner },
      { $set: { status: 'open', lifecycleRev: 0 } },
      { upsert: true }
    );
    return { id, owner };
  }

  function request(owner, buffer = archiveBuffer) {
    return {
      user: { id: owner },
      files: { file: [{ buffer }] }
    };
  }

  try {
    for (const { Model, format } of archiveModels) {
      const { owner } = await seedUser();
      let journalOwner = owner;
      const written = [];
      let removeFailure = null;
      let providerFailure = false;
      const blobStore = {
        async createNamed(container, name, file) {
          const journal = await journalCollection.findOne({ owner: journalOwner, blobName: name });
          assert(journal && journal.status === 'uploading');
          const { name: blob } = await fileMedia.writeNamed(name, file.buffer);
          written.push(blob);
          if (providerFailure) throw new Error('provider write acknowledgement lost');
          return [{ container, name: blob }];
        },
        async remove(container, name) {
          if (removeFailure && removeFailure(name)) throw new Error('synthetic remove failure');
          return fileMedia.remove(name);
        }
      };
      const controller = createCommunicationPrivateLibraryController({
        PrivateLibrary: Model,
        blobStore,
        lifecycle,
        storageConfigured: () => true,
        archiveFormat: format,
        lifecycleEnabled: () => true
      });
      const first = response();
      await controller.uploadPrivateLibrary(request(owner), first);
      assert.equal(first.statusCode, 200);
      assert.equal(await journalCollection.countDocuments({ owner }), 0);
      const firstMetadata = await Model.findOne({ user: owner }).select('+blobName').lean().exec();
      assert(firstMetadata && firstMetadata.blobName === written[0]);
      passed.push(`${Model.modelName}-journal-prepared-before-upload-and-cleaned-after-publish`);

      const oldBlob = written[0];
      let failedOldRemoval = true;
      removeFailure = name => name === oldBlob && failedOldRemoval;
      const replacement = response();
      await controller.uploadPrivateLibrary(request(owner), replacement);
      assert.equal(replacement.statusCode, 200);
      const replacementMetadata = await Model.findOne({ user: owner }).select('+blobName').lean().exec();
      assert.equal(replacementMetadata.blobName, written[1]);
      const publishedJournal = await journalCollection.findOne({ owner, status: 'published' });
      assert(publishedJournal && publishedJournal.previousBlobName === oldBlob);
      failedOldRemoval = false;
      const restarted = createCommunicationPrivateLibraryController({
        PrivateLibrary: Model,
        blobStore,
        lifecycle,
        storageConfigured: () => true,
        archiveFormat: format,
        lifecycleEnabled: () => true
      });
      await restarted.deletePrivateLibraryForUser(owner);
      assert.equal(await journalCollection.countDocuments({ owner }), 0);
      assert.equal(await Model.countDocuments({ user: owner }), 0);
      await assert.rejects(fileMedia.read(oldBlob), error => error.code === 'MEDIA_FILE_DELETED');
      await assert.rejects(fileMedia.read(written[1]), error => error.code === 'MEDIA_FILE_DELETED');
      passed.push(`${Model.modelName}-replacement-journal-drain-retries-old-and-current-delete`);

      const closingUser = await seedUser();
      let closingRemoveFailure = true;
      const closingBlobStore = {
        async createNamed(container, name, file) {
          const { name: blob } = await fileMedia.writeNamed(name, file.buffer);
          await lifecycle.withOpenAccount(closingUser.owner, async () => {});
          await coordinator.begin(closingUser.owner, []);
          return [{ container, name: blob }];
        },
        async remove(container, name) {
          if (closingRemoveFailure) throw new Error('synthetic cleanup interruption');
          return fileMedia.remove(name);
        }
      };
      const closingController = createCommunicationPrivateLibraryController({
        PrivateLibrary: Model,
        blobStore: closingBlobStore,
        lifecycle,
        storageConfigured: () => true,
        archiveFormat: format,
        lifecycleEnabled: () => true
      });
      const closingResponse = response();
      await closingController.uploadPrivateLibrary(request(closingUser.owner), closingResponse);
      assert.equal(closingResponse.statusCode, 409);
      const failedJournal = await journalCollection.findOne({ owner: closingUser.owner });
      assert(failedJournal && failedJournal.status === 'failed');
      const recoveryController = createCommunicationPrivateLibraryController({
        PrivateLibrary: Model,
        blobStore: closingBlobStore,
        lifecycle,
        storageConfigured: () => true,
        archiveFormat: format,
        lifecycleEnabled: () => true
      });
      closingRemoveFailure = false;
      await recoveryController.deletePrivateLibraryForUser(closingUser.owner);
      assert.equal(await journalCollection.countDocuments({ owner: closingUser.owner }), 0);
      passed.push(`${Model.modelName}-failed-journal-survives-close-and-recovers`);

      const pendingUser = await seedUser();
      journalOwner = pendingUser.owner;
      providerFailure = true;
      const pendingResponse = response();
      await controller.uploadPrivateLibrary(request(pendingUser.owner), pendingResponse);
      assert.equal(pendingResponse.statusCode, 500);
      const pendingJournal = await journalCollection.findOne({ owner: pendingUser.owner });
      assert(pendingJournal && pendingJournal.status === 'uploading');
      const pendingRecovery = createCommunicationPrivateLibraryController({
        PrivateLibrary: Model,
        blobStore,
        lifecycle,
        storageConfigured: () => true,
        archiveFormat: format,
        lifecycleEnabled: () => true
      });
      await assert.rejects(
        pendingRecovery.deletePrivateLibraryForUser(pendingUser.owner),
        error => error.code === 'PRIVATE_ARCHIVE_UPLOAD_PENDING'
      );
      assert.equal(await journalCollection.countDocuments({ owner: pendingUser.owner, status: 'uploading' }), 1);
      assert.equal(await fileMedia.read(written[written.length - 1]).then(() => true), true);
      passed.push(`${Model.modelName}-provider-ack-loss-keeps-uploading-journal-and-blob`);
    }
  } finally {
    if (previousFlag === undefined) delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    else process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = previousFlag;
  }
};

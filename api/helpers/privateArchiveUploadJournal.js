'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { createCareFamilyLifecycle } = require('./careFamilyLifecycle');

function fail(code) {
  throw Object.assign(new Error(code), { status: 503, code });
}

// Internal recovery adapter, never accepts an object name from an HTTP body.
// The object is named and recorded before external I/O. Unknown uploads remain
// pending until their worker/provider completion can be established.
function createPrivateArchiveUploadJournal({ PrivateLibrary, blobStore, containerName,
  connection = mongoose.connection, lifecycle = null, now = Date.now } = {}) {
  const kind = PrivateLibrary && PrivateLibrary.modelName;
  if (!kind || !blobStore || typeof blobStore.remove !== 'function' || !containerName) {
    throw new TypeError('Private archive journal adapters required');
  }
  const jobs = connection.collection('privatearchiveuploads');
  const gate = lifecycle || createCareFamilyLifecycle({ connection });
  const scope = (owner, id) => ({ _id: id, owner, kind, containerName });

  async function prepare(owner) {
    const id = crypto.randomBytes(24).toString('hex');
    const job = { _id: id, owner, kind, containerName, blobName: `${id}.bin`,
      status: 'uploading', createdAt: now(), updatedAt: now() };
    await gate.withOpenAccount(owner, session => jobs.insertOne(job, { session }));
    return job;
  }

  async function publish(owner, id, publishMetadata) {
    return gate.withOpenAccount(owner, async session => {
      const job = await jobs.findOne(scope(owner, id), { session });
      if (!job || job.status !== 'uploading') fail('PRIVATE_ARCHIVE_RECONCILIATION_REQUIRED');
      const previous = await publishMetadata(session);
      const result = await jobs.updateOne({ ...scope(owner, id), status: 'uploading' }, {
        $set: { status: 'published', previousBlobName: previous && previous.blobName || null,
          updatedAt: now() }
      }, { session });
      if (Number(result.matchedCount === undefined ? result.n : result.matchedCount) !== 1) {
        fail('PRIVATE_ARCHIVE_RECONCILIATION_REQUIRED');
      }
      return previous;
    });
  }

  // Call only after the upload promise succeeded. An upload error can mean
  // the provider is still writing; that case must retain status=uploading.
  async function failedPublish(owner, id) {
    await jobs.updateOne({ ...scope(owner, id), status: 'uploading' }, {
      $set: { status: 'failed', updatedAt: now() }
    });
  }

  async function cleanup(owner, id) {
    const job = await jobs.findOne(scope(owner, id));
    if (!job) return;
    if (!['published', 'failed'].includes(job.status)) fail('PRIVATE_ARCHIVE_UPLOAD_PENDING');
    const target = job.status === 'published' ? job.previousBlobName : job.blobName;
    if (target) {
      // A commit acknowledgement may have been lost. Never remove the active
      // archive even if an operation was incorrectly assumed to have failed.
      const current = await PrivateLibrary.findOne({ user: owner, blobName: target })
        .select('+blobName').lean().exec();
      if (current) fail('PRIVATE_ARCHIVE_RECONCILIATION_REQUIRED');
      try { await blobStore.remove(containerName, target); }
      catch (_) { fail('PRIVATE_ARCHIVE_CLEANUP_RETRY_REQUIRED'); }
    }
    await jobs.deleteOne({ ...scope(owner, id), status: job.status });
  }

  async function drain(owner) {
    const pending = await jobs.find({ owner, kind, containerName }).limit(101).toArray();
    // Process only terminal upload attempts. In-flight or unknown attempts
    // prevent account finalization; no TTL takeover or inferred provider stop.
    for (const job of pending.slice(0, 100)) await cleanup(owner, job._id);
    if (pending.length > 100) fail('PRIVATE_ARCHIVE_CLEANUP_RETRY_REQUIRED');
  }

  return { prepare, publish, failedPublish, cleanup, drain };
}

module.exports = { createPrivateArchiveUploadJournal };

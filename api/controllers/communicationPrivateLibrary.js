'use strict';

const crypto = require('crypto');
const CommunicationPrivateLibrary = require('../models/CommunicationPrivateLibrary');
const {
  createBlockBlobFromText,
  createBlockBlobWithName,
  deleteBlobIfExists,
  getBlobToBuffer,
  isBlobStorageConfigured
} = require('../helpers/blob');
const { createCareFamilyLifecycle } = require('../helpers/careFamilyLifecycle');
const { createPrivateArchiveUploadJournal } = require('../helpers/privateArchiveUploadJournal');

const PRIVATE_LIBRARY_CONTAINER_NAME =
  process.env.PRIVATE_LIBRARY_CONTAINER_NAME || 'cboard-private';
const PRIVATE_LIBRARY_LEGACY_FORMAT = 'picinterpreter-picture-library';
const PRIVATE_LIBRARY_FORMAT =
  'picinterpreter-private-picture-library-encrypted';
const PRIVATE_LIBRARY_CONTRACT_VERSION = 2;
const PRIVATE_LIBRARY_FILE_NAME =
  'picinterpreter-private-picture-library.pijenc';
const PRIVATE_LIBRARY_CONTENT_TYPE = 'application/octet-stream';
const MAX_PRIVATE_LIBRARY_BYTES = 20 * 1024 * 1024;
const PRIVATE_ARCHIVE_MAGIC = Buffer.from('PIE2EE01', 'ascii');

function isEncryptedPrivateArchiveBuffer(value) {
  return (
    Buffer.isBuffer(value) &&
    value.length > PRIVATE_ARCHIVE_MAGIC.length &&
    value
      .subarray(0, PRIVATE_ARCHIVE_MAGIC.length)
      .equals(PRIVATE_ARCHIVE_MAGIC)
  );
}

function serializeMetadata(value) {
  if (!value) return null;
  return {
    format: value.format,
    contractVersion: value.contractVersion,
    size: value.size,
    sha256: value.sha256,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function createCommunicationPrivateLibraryController({
  PrivateLibrary = CommunicationPrivateLibrary,
  blobStore = {
    create: createBlockBlobFromText,
    createNamed: createBlockBlobWithName,
    read: getBlobToBuffer,
    remove: deleteBlobIfExists
  },
  containerName = PRIVATE_LIBRARY_CONTAINER_NAME,
  archiveLabel = 'Private picture library',
  archiveFileName = PRIVATE_LIBRARY_FILE_NAME,
  archiveFormat = PRIVATE_LIBRARY_FORMAT,
  archiveContractVersion = PRIVATE_LIBRARY_CONTRACT_VERSION,
  archiveContentType = PRIVATE_LIBRARY_CONTENT_TYPE,
  archiveValidator = isEncryptedPrivateArchiveBuffer,
  invalidArchiveMessage = `${archiveLabel} must be a client-encrypted PicInterpreter backup up to 20 MiB`,
  legacyArchiveFormats = [PRIVATE_LIBRARY_LEGACY_FORMAT],
  legacyArchiveErrorCode = 'PRIVATE_PICTURE_LIBRARY_REENCRYPTION_REQUIRED',
  legacyArchiveMessage = `${archiveLabel} must be re-uploaded in the current encrypted format`,
  storageConfigured = isBlobStorageConfigured,
  lifecycle = null,
  uploadJournal = null,
  lifecycleEnabled = () => process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true',
  now = Date.now
} = {}) {
  let journal = uploadJournal;
  function getJournal() {
    if (!journal) journal = createPrivateArchiveUploadJournal({
      PrivateLibrary, blobStore, containerName, lifecycle, now
    });
    return journal;
  }
  function rejectUnconfiguredStorage(res) {
    if (storageConfigured()) return null;
    return res.status(503).json({
      message: `${archiveLabel} storage is not configured`
    });
  }

  async function findForUser(userId) {
    return PrivateLibrary.findOne({ user: userId })
      .select('+blobName')
      .lean()
      .exec();
  }

  async function publishMetadata(userId, update, session) {
    const options = {
      new: false,
      upsert: true,
      setDefaultsOnInsert: true,
      ...(session ? { session } : {})
    };
    return PrivateLibrary.findOneAndUpdate({ user: userId }, update, options)
      .select('+blobName')
      .lean()
      .exec();
  }

  async function publishMetadataWithLifecycle(userId, update) {
    if (!lifecycleEnabled()) return publishMetadata(userId, update);
    const activeLifecycle = lifecycle || createCareFamilyLifecycle();
    return activeLifecycle.withOpenAccount(userId, session =>
      publishMetadata(userId, update, session)
    );
  }

  async function removeForUser(userId) {
    if (lifecycleEnabled()) await getJournal().drain(String(userId));
    const existing = await findForUser(userId);
    if (!existing) return false;
    if (!storageConfigured()) {
      throw new Error(`${archiveLabel} storage is not configured`);
    }
    await blobStore.remove(containerName, existing.blobName);
    await PrivateLibrary.deleteOne({
      user: userId,
      blobName: existing.blobName
    });
    return true;
  }

  async function getPrivateLibraryMetadata(req, res) {
    if (!req.user) {
      return res.status(400).json({
        message: 'Are you logged in? Is bearer token present?'
      });
    }
    const unavailable = rejectUnconfiguredStorage(res);
    if (unavailable) return unavailable;
    try {
      const existing = await findForUser(req.user.id);
      if (!existing) {
        return res.status(404).json({
          message: `${archiveLabel} backup not found`
        });
      }
      if (legacyArchiveFormats.includes(existing.format)) {
        return res.status(409).json({
          code: legacyArchiveErrorCode,
          message: legacyArchiveMessage
        });
      }
      return res.status(200).json(serializeMetadata(existing));
    } catch (error) {
      return res.status(500).json({
        message: `Error reading ${archiveLabel.toLowerCase()} metadata`
      });
    }
  }

  async function uploadPrivateLibrary(req, res) {
    if (!req.user) {
      return res.status(400).json({
        message: 'Are you logged in? Is bearer token present?'
      });
    }
    const unavailable = rejectUnconfiguredStorage(res);
    if (unavailable) return unavailable;
    const file =
      req.files && Array.isArray(req.files.file) && req.files.file.length
        ? req.files.file[0]
        : null;
    const buffer = file && file.buffer;
    if (
      !archiveValidator(buffer) ||
      buffer.length > MAX_PRIVATE_LIBRARY_BYTES
    ) {
      return res.status(400).json({
        message: invalidArchiveMessage
      });
    }

    const timestamp = now();
    const sha256 = crypto
      .createHash('sha256')
      .update(buffer)
      .digest('hex');
    let newBlobName = '';
    let uploadJob = null;
    let uploadCompleted = false;
    try {
      if (lifecycleEnabled()) {
        if (typeof blobStore.createNamed !== 'function') {
          throw Object.assign(new Error('Named archive storage required'), { code: 'PRIVATE_ARCHIVE_TRACKING_UNAVAILABLE' });
        }
        uploadJob = await getJournal().prepare(String(req.user.id));
      }
      const [storedBlob] = uploadJob
        ? await blobStore.createNamed(containerName, uploadJob.blobName,
          { buffer, mimetype: archiveContentType }, { cacheControl: 'private, no-store' })
        : await blobStore.create(
        containerName,
        archiveFileName,
        {
          buffer,
          mimetype: archiveContentType
        },
        'account',
        {
          cacheControl: 'private, no-store'
        }
      );
      newBlobName = storedBlob && storedBlob.name;
      if (!newBlobName) {
        throw new Error('Private blob upload did not return a blob name');
      }
      if (uploadJob && newBlobName !== uploadJob.blobName) {
        throw Object.assign(new Error('Archive storage name mismatch'), { code: 'PRIVATE_ARCHIVE_RECONCILIATION_REQUIRED' });
      }
      uploadCompleted = true;

      const update = {
        $set: {
          blobName: newBlobName,
          format: archiveFormat,
          contractVersion: archiveContractVersion,
          size: buffer.length,
          sha256,
          updatedAt: timestamp
        },
        $setOnInsert: {
          createdAt: timestamp
        }
      };
      const previous = uploadJob
        ? await getJournal().publish(String(req.user.id), uploadJob._id,
          session => publishMetadata(req.user.id, update, session))
        : await publishMetadataWithLifecycle(req.user.id, update);

      if (uploadJob) {
        try { await getJournal().cleanup(String(req.user.id), uploadJob._id); }
        catch (_) { console.error('Private archive cleanup remains pending'); }
      } else if (previous && previous.blobName && previous.blobName !== newBlobName) {
        try {
          await blobStore.remove(containerName, previous.blobName);
        } catch (cleanupError) {
          console.error('Unable to remove replaced private library blob');
        }
      }

      return res.status(200).json({
        format: archiveFormat,
        contractVersion: archiveContractVersion,
        size: buffer.length,
        sha256,
        createdAt:
          previous && previous.createdAt ? previous.createdAt : timestamp,
        updatedAt: timestamp
      });
    } catch (error) {
      if (uploadJob) {
        if (uploadCompleted) {
          try {
            await getJournal().failedPublish(String(req.user.id), uploadJob._id);
            await getJournal().cleanup(String(req.user.id), uploadJob._id);
          } catch (_) { console.error('Private archive cleanup remains pending'); }
        }
      } else if (newBlobName) {
        try {
          await blobStore.remove(containerName, newBlobName);
        } catch (cleanupError) {
          console.error('Unable to roll back private library blob');
        }
      }
      if (error && error.code === 'ACCOUNT_CLOSING') {
        return res.status(409).json({ message: 'Account is closing', error: { code: 'ACCOUNT_CLOSING' } });
      }
      if (error && error.code === 'ACCOUNT_CLOSED') {
        return res.status(403).json({ message: 'Account is closed', error: { code: 'ACCOUNT_CLOSED' } });
      }
      if (error && typeof error.code === 'string' && error.code.startsWith('PRIVATE_ARCHIVE_')) {
        return res.status(503).json({ message: 'Private archive operation requires retry or recovery', error: { code: error.code } });
      }
      return res.status(500).json({
        message: `Error storing ${archiveLabel.toLowerCase()} backup`
      });
    }
  }

  async function downloadPrivateLibrary(req, res) {
    if (!req.user) {
      return res.status(400).json({
        message: 'Are you logged in? Is bearer token present?'
      });
    }
    const unavailable = rejectUnconfiguredStorage(res);
    if (unavailable) return unavailable;
    try {
      const existing = await findForUser(req.user.id);
      if (!existing) {
        return res.status(404).json({
          message: `${archiveLabel} backup not found`
        });
      }
      if (legacyArchiveFormats.includes(existing.format)) {
        return res.status(409).json({
          code: legacyArchiveErrorCode,
          message: legacyArchiveMessage
        });
      }
      const buffer = await blobStore.read(containerName, existing.blobName);
      const sha256 = crypto
        .createHash('sha256')
        .update(buffer)
        .digest('hex');
      if (
        existing.format !== archiveFormat ||
        existing.contractVersion !== archiveContractVersion ||
        !archiveValidator(buffer) ||
        buffer.length !== existing.size ||
        sha256 !== existing.sha256
      ) {
        return res.status(502).json({
          message: `${archiveLabel} backup failed integrity check`
        });
      }
      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="${archiveFileName}"`,
        'Content-Length': String(buffer.length),
        'Content-Type': archiveContentType
      });
      return res.status(200).send(buffer);
    } catch (error) {
      return res.status(500).json({
        message: `Error downloading ${archiveLabel.toLowerCase()} backup`
      });
    }
  }

  async function deletePrivateLibrary(req, res) {
    if (!req.user) {
      return res.status(400).json({
        message: 'Are you logged in? Is bearer token present?'
      });
    }
    const unavailable = rejectUnconfiguredStorage(res);
    if (unavailable) return unavailable;
    try {
      const deleted = await removeForUser(req.user.id);
      return res.status(200).json({ deleted });
    } catch (error) {
      return res.status(500).json({
        message: `Error deleting ${archiveLabel.toLowerCase()} backup`
      });
    }
  }

  return {
    deletePrivateLibrary,
    deletePrivateLibraryForUser: removeForUser,
    downloadPrivateLibrary,
    getPrivateLibraryMetadata,
    uploadPrivateLibrary
  };
}

const controller = createCommunicationPrivateLibraryController();

module.exports = {
  MAX_PRIVATE_LIBRARY_BYTES,
  PRIVATE_LIBRARY_CONTENT_TYPE,
  PRIVATE_LIBRARY_CONTRACT_VERSION,
  PRIVATE_LIBRARY_FILE_NAME,
  PRIVATE_LIBRARY_FORMAT,
  PRIVATE_LIBRARY_LEGACY_FORMAT,
  createCommunicationPrivateLibraryController,
  deletePrivateLibrary: controller.deletePrivateLibrary,
  deletePrivateLibraryForUser: controller.deletePrivateLibraryForUser,
  downloadPrivateLibrary: controller.downloadPrivateLibrary,
  getPrivateLibraryMetadata: controller.getPrivateLibraryMetadata,
  isEncryptedPrivateArchiveBuffer,
  uploadPrivateLibrary: controller.uploadPrivateLibrary
};

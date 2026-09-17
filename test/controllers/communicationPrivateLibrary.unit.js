'use strict';

const crypto = require('crypto');
const chai = require('chai');
const {
  MAX_PRIVATE_LIBRARY_BYTES,
  PRIVATE_LIBRARY_CONTENT_TYPE,
  PRIVATE_LIBRARY_CONTRACT_VERSION,
  PRIVATE_LIBRARY_FILE_NAME,
  PRIVATE_LIBRARY_FORMAT,
  PRIVATE_LIBRARY_LEGACY_FORMAT,
  createCommunicationPrivateLibraryController
} = require('../../api/controllers/communicationPrivateLibrary');
const {
  PRIVATE_DEVICE_DATA_CONTENT_TYPE,
  PRIVATE_DEVICE_DATA_CONTRACT_VERSION,
  PRIVATE_DEVICE_DATA_FILE_NAME,
  PRIVATE_DEVICE_DATA_FORMAT,
  isEncryptedPrivateDeviceDataBuffer
} = require('../../api/controllers/communicationPrivateDeviceData');

const expect = chai.expect;

function createZipBuffer(value = 'library') {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(value)
  ]);
}

function createEncryptedArchiveBuffer(value = 'device-data') {
  return Buffer.concat([Buffer.from('PIE2EE01', 'ascii'), Buffer.from(value)]);
}

function createQuery(value) {
  return {
    select() {
      return this;
    },
    lean() {
      return this;
    },
    async exec() {
      return value;
    }
  };
}

function createResponse() {
  return {
    body: null,
    headers: {},
    statusCode: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
    set(value) {
      Object.assign(this.headers, value);
      return this;
    }
  };
}

function createHarness(initial = null, options = {}) {
  let stored = initial;
  let nextBlob = 1;
  const removed = [];
  const uploaded = [];
  const metadataUpdates = [];
  const journalCalls = [];
  const journalJobs = new Map();
  let nextJournal = 1;
  let downloadBuffer = initial
    ? createEncryptedArchiveBuffer('existing')
    : null;

  const PrivateLibrary = {
    findOne(filter) {
      return createQuery(stored && stored.user === filter.user ? stored : null);
    },
    findOneAndUpdate(filter, update, queryOptions) {
      if (options.publishMetadataError) throw options.publishMetadataError;
      metadataUpdates.push({ filter, update, options: queryOptions });
      const previous =
        stored && stored.user === filter.user ? { ...stored } : null;
      stored = {
        ...(previous || update.$setOnInsert),
        ...update.$set,
        user: filter.user
      };
      return createQuery(previous);
    },
    async deleteOne(filter) {
      if (
        stored &&
        stored.user === filter.user &&
        stored.blobName === filter.blobName
      ) {
        stored = null;
        return { deletedCount: 1 };
      }
      return { deletedCount: 0 };
    }
  };
  const blobStore = {
    async create(
      containerName,
      fileName,
      file,
      prefix,
      contentSettings,
      containerOptions
    ) {
      const name = `private-${nextBlob++}.pijenc`;
      uploaded.push({
        containerName,
        fileName,
        file,
        prefix,
        contentSettings,
        containerOptions,
        name
      });
      downloadBuffer = Buffer.from(file.buffer);
      return [{ name }, 'https://must-not-be-returned.example/private.zip'];
    },
    async createNamed(containerName, blobName, file, contentSettings) {
      uploaded.push({
        containerName,
        blobName,
        file,
        contentSettings,
        name: blobName
      });
      downloadBuffer = Buffer.from(file.buffer);
      if (options.createNamedError) throw options.createNamedError;
      return [{ name: blobName }, 'https://must-not-be-returned.example/private.zip'];
    },
    async read() {
      return Buffer.from(downloadBuffer || []);
    },
    async remove(containerName, blobName) {
      removed.push({ containerName, blobName });
      return true;
    }
  };
  const uploadJournal = options.uploadJournal || {
    async prepare(owner) {
      const id = `journal-${nextJournal++}`;
      const job = { _id: id, owner, blobName: `${id}.bin` };
      journalCalls.push({ method: 'prepare', owner });
      journalJobs.set(id, job);
      return job;
    },
    async publish(owner, id, publishMetadataCallback) {
      journalCalls.push({ method: 'publish', owner, id });
      const session = { id: 'journal-session' };
      const previous = options.lifecycle
        ? await options.lifecycle.withOpenAccount(owner, publishMetadataCallback)
        : await publishMetadataCallback(session);
      journalJobs.get(id).status = 'published';
      journalJobs.get(id).previousBlobName = previous && previous.blobName;
      return previous;
    },
    async failedPublish(owner, id) {
      journalCalls.push({ method: 'failedPublish', owner, id });
      journalJobs.get(id).status = 'failed';
    },
    async cleanup(owner, id) {
      journalCalls.push({ method: 'cleanup', owner, id });
      if (options.cleanupError) throw options.cleanupError;
      const job = journalJobs.get(id);
      if (job && job.status === 'failed') {
        await blobStore.remove('private-test', job.blobName);
      }
      journalJobs.delete(id);
    },
    async drain() {}
  };
  const controller = createCommunicationPrivateLibraryController({
    PrivateLibrary,
    blobStore,
    containerName: 'private-test',
    archiveLabel: options.archiveLabel,
    archiveFileName: options.archiveFileName,
    archiveFormat: options.archiveFormat,
    archiveContractVersion: options.archiveContractVersion,
    archiveContentType: options.archiveContentType,
    archiveValidator: options.archiveValidator,
    invalidArchiveMessage: options.invalidArchiveMessage,
    legacyArchiveFormats: options.legacyArchiveFormats,
    legacyArchiveErrorCode: options.legacyArchiveErrorCode,
    legacyArchiveMessage: options.legacyArchiveMessage,
    storageConfigured: () => options.storageConfigured !== false,
    lifecycle: options.lifecycle,
    uploadJournal,
    lifecycleEnabled: options.lifecycleEnabled || (() => false),
    now: () => 1700000000000
  });

  return {
    blobStore,
    controller,
    getStored: () => stored,
    removed,
    setDownloadBuffer(value) {
      downloadBuffer = value;
    },
    uploaded,
    metadataUpdates
    ,journalCalls
    ,journalJobs
  };
}

function createRequest(file) {
  return {
    user: { id: 'user-1' },
    ...(file ? { files: { file: [file] } } : {})
  };
}

describe('Private picture library controller', function() {
  it('returns 503 before touching storage when Azure is unconfigured', async function() {
    const harness = createHarness(null, { storageConfigured: false });
    const response = createResponse();

    await harness.controller.uploadPrivateLibrary(
      createRequest({
        buffer: createEncryptedArchiveBuffer(),
        originalname: 'library.pijenc'
      }),
      response
    );

    expect(response.statusCode).to.equal(503);
    expect(response.body.message).to.match(/not configured/);
    expect(harness.uploaded).to.have.length(0);
  });

  it('rejects malformed and oversized uploads before blob storage', async function() {
    const harness = createHarness();
    const malformed = createResponse();
    await harness.controller.uploadPrivateLibrary(
      createRequest({
        buffer: Buffer.from('not-a-zip'),
        originalname: 'library.zip'
      }),
      malformed
    );
    expect(malformed.statusCode).to.equal(400);

    const oversized = createResponse();
    const buffer = Buffer.alloc(MAX_PRIVATE_LIBRARY_BYTES + 1);
    Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(buffer);
    await harness.controller.uploadPrivateLibrary(
      createRequest({ buffer, originalname: 'library.zip' }),
      oversized
    );
    expect(oversized.statusCode).to.equal(400);
    expect(harness.uploaded).to.have.length(0);
  });

  it('rejects plaintext picture ZIPs and preserves legacy backups for migration or deletion', async function() {
    const harness = createHarness();
    const uploadResponse = createResponse();
    await harness.controller.uploadPrivateLibrary(
      createRequest({
        buffer: createZipBuffer('plaintext-pictures'),
        originalname: 'private-library.zip'
      }),
      uploadResponse
    );
    expect(uploadResponse.statusCode).to.equal(400);
    expect(uploadResponse.body.message).to.match(/client-encrypted/);

    const legacyBuffer = createZipBuffer('legacy-pictures');
    const legacyHarness = createHarness({
      user: 'user-1',
      blobName: 'legacy-private-library.zip',
      format: PRIVATE_LIBRARY_LEGACY_FORMAT,
      contractVersion: 1,
      size: legacyBuffer.length,
      sha256: crypto
        .createHash('sha256')
        .update(legacyBuffer)
        .digest('hex'),
      createdAt: 100,
      updatedAt: 200
    });
    const metadataResponse = createResponse();
    await legacyHarness.controller.getPrivateLibraryMetadata(
      createRequest(),
      metadataResponse
    );
    expect(metadataResponse.statusCode).to.equal(409);
    expect(metadataResponse.body.code).to.equal(
      'PRIVATE_PICTURE_LIBRARY_REENCRYPTION_REQUIRED'
    );

    const deleteResponse = createResponse();
    await legacyHarness.controller.deletePrivateLibrary(
      createRequest(),
      deleteResponse
    );
    expect(deleteResponse.statusCode).to.equal(200);
    expect(deleteResponse.body).to.deep.equal({ deleted: true });
  });

  it('stores one private snapshot without returning a blob URL', async function() {
    const harness = createHarness();
    const buffer = createEncryptedArchiveBuffer();
    const response = createResponse();

    await harness.controller.uploadPrivateLibrary(
      createRequest({ buffer, originalname: 'library.pijenc' }),
      response
    );

    expect(response.statusCode).to.equal(200);
    expect(response.body).to.include({
      format: PRIVATE_LIBRARY_FORMAT,
      contractVersion: PRIVATE_LIBRARY_CONTRACT_VERSION,
      size: buffer.length,
      createdAt: 1700000000000,
      updatedAt: 1700000000000
    });
    expect(response.body).not.to.have.property('url');
    expect(response.body.sha256).to.equal(
      crypto
        .createHash('sha256')
        .update(buffer)
        .digest('hex')
    );
    expect(harness.uploaded[0]).to.include({
      containerName: 'private-test',
      prefix: 'account'
    });
    expect(harness.uploaded[0].fileName).to.equal(PRIVATE_LIBRARY_FILE_NAME);
    expect(harness.uploaded[0].file.mimetype).to.equal(
      PRIVATE_LIBRARY_CONTENT_TYPE
    );
    expect(harness.uploaded[0].contentSettings).to.deep.equal({
      cacheControl: 'private, no-store'
    });
    expect(harness.uploaded[0].containerOptions).to.equal(undefined);
    expect(harness.getStored().blobName).to.equal('private-1.pijenc');
    expect(harness.metadataUpdates[0].options.session).to.equal(undefined);
  });

  it('publishes metadata through the account lifecycle session when enabled', async function() {
    const session = { id: 'session-1' };
    const calls = [];
    const harness = createHarness(null, {
      lifecycleEnabled: () => true,
      lifecycle: {
        async withOpenAccount(id, callback) {
          calls.push(id);
          return callback(session);
        }
      }
    });
    const response = createResponse();

    await harness.controller.uploadPrivateLibrary(
      createRequest({ buffer: createEncryptedArchiveBuffer() }),
      response
    );

    expect(response.statusCode).to.equal(200);
    expect(calls).to.deep.equal(['user-1']);
    expect(harness.metadataUpdates[0].options.session).to.equal(session);
    expect(harness.removed).to.deep.equal([]);
  });

  it('prepares a named journal object before upload and cleans a published job', async function() {
    const harness = createHarness(null, { lifecycleEnabled: () => true });
    const response = createResponse();

    await harness.controller.uploadPrivateLibrary(
      createRequest({ buffer: createEncryptedArchiveBuffer('journaled') }),
      response
    );

    expect(response.statusCode).to.equal(200);
    expect(harness.journalCalls.map(call => call.method)).to.deep.equal([
      'prepare', 'publish', 'cleanup'
    ]);
    expect(harness.uploaded[0].blobName).to.equal('journal-1.bin');
    expect(harness.metadataUpdates[0].options.session).to.deep.equal({
      id: 'journal-session'
    });
    expect(harness.journalJobs.size).to.equal(0);
  });

  it('marks a successful provider upload failed and cleans it when publication fails', async function() {
    const harness = createHarness(null, {
      lifecycleEnabled: () => true,
      publishMetadataError: Object.assign(new Error('transaction aborted'), {
        code: 'ACCOUNT_CLOSING'
      })
    });
    const response = createResponse();

    await harness.controller.uploadPrivateLibrary(
      createRequest({ buffer: createEncryptedArchiveBuffer('publish-fails') }),
      response
    );

    expect(response.statusCode).to.equal(409);
    expect(response.body.error.code).to.equal('ACCOUNT_CLOSING');
    expect(harness.journalCalls.map(call => call.method)).to.deep.equal([
      'prepare', 'publish', 'failedPublish', 'cleanup'
    ]);
    expect(harness.removed).to.deep.equal([
      { containerName: 'private-test', blobName: 'journal-1.bin' }
    ]);
    expect(harness.getStored()).to.equal(null);
  });

  it('retains an upload journal when the provider fails before completion', async function() {
    const harness = createHarness(null, {
      lifecycleEnabled: () => true,
      createNamedError: new Error('provider request may still be writing')
    });
    const response = createResponse();

    await harness.controller.uploadPrivateLibrary(
      createRequest({ buffer: createEncryptedArchiveBuffer('provider-fails') }),
      response
    );

    expect(response.statusCode).to.equal(500);
    expect(harness.journalCalls.map(call => call.method)).to.deep.equal([
      'prepare'
    ]);
    expect(harness.journalJobs.size).to.equal(1);
    expect(harness.removed).to.deep.equal([]);
  });

  it('does not remove the new current blob when journal cleanup fails', async function() {
    const old = {
      user: 'user-1',
      blobName: 'old-private.zip',
      format: PRIVATE_LIBRARY_FORMAT,
      contractVersion: PRIVATE_LIBRARY_CONTRACT_VERSION,
      size: 1,
      sha256: 'old',
      createdAt: 100,
      updatedAt: 100
    };
    const harness = createHarness(old, {
      lifecycleEnabled: () => true,
      cleanupError: Object.assign(new Error('cleanup must be retried'), {
        code: 'PRIVATE_ARCHIVE_CLEANUP_RETRY_REQUIRED'
      })
    });
    const response = createResponse();

    await harness.controller.uploadPrivateLibrary(
      createRequest({ buffer: createEncryptedArchiveBuffer('cleanup-fails') }),
      response
    );

    expect(response.statusCode).to.equal(200);
    expect(harness.getStored().blobName).to.equal('journal-1.bin');
    expect(harness.removed).to.deep.equal([]);
    expect(harness.journalCalls.map(call => call.method)).to.deep.equal([
      'prepare', 'publish', 'cleanup'
    ]);
  });

  it('rejects metadata publication for a closing account and removes only the new blob', async function() {
    const harness = createHarness({
      user: 'user-1', blobName: 'old-private.zip', format: PRIVATE_LIBRARY_FORMAT,
      contractVersion: PRIVATE_LIBRARY_CONTRACT_VERSION, size: 1, sha256: 'old', createdAt: 100, updatedAt: 100
    }, {
      lifecycleEnabled: () => true,
      publishMetadataError: Object.assign(new Error('closing'), {
        code: 'ACCOUNT_CLOSING'
      })
    });
    const response = createResponse();

    await harness.controller.uploadPrivateLibrary(
      createRequest({ buffer: createEncryptedArchiveBuffer('late') }),
      response
    );

    expect(response.statusCode).to.equal(409);
    expect(response.body.error.code).to.equal('ACCOUNT_CLOSING');
    expect(harness.getStored().blobName).to.equal('old-private.zip');
    expect(harness.removed).to.deep.equal([{ containerName: 'private-test', blobName: 'journal-1.bin' }]);
    expect(harness.metadataUpdates).to.have.length(0);
  });

  it('returns ACCOUNT_CLOSED for a closed account without leaking the lifecycle error', async function() {
    const harness = createHarness(null, {
      lifecycleEnabled: () => true,
      publishMetadataError: Object.assign(new Error('closed internals'), {
        code: 'ACCOUNT_CLOSED'
      })
    });
    const response = createResponse();

    await harness.controller.uploadPrivateLibrary(
      createRequest({ buffer: createEncryptedArchiveBuffer('closed') }),
      response
    );

    expect(response.statusCode).to.equal(403);
    expect(response.body.error.code).to.equal('ACCOUNT_CLOSED');
    expect(response.body.message).to.equal('Account is closed');
    expect(harness.removed).to.have.length(1);
    expect(harness.metadataUpdates).to.have.length(0);
  });

  it('reuses the same private archive controller for a separate device-data snapshot', async function() {
    const harness = createHarness(null, {
      archiveLabel: 'Private device data',
      archiveFileName: PRIVATE_DEVICE_DATA_FILE_NAME,
      archiveFormat: PRIVATE_DEVICE_DATA_FORMAT,
      archiveContractVersion: PRIVATE_DEVICE_DATA_CONTRACT_VERSION,
      archiveContentType: PRIVATE_DEVICE_DATA_CONTENT_TYPE,
      archiveValidator: isEncryptedPrivateDeviceDataBuffer
    });
    const buffer = createEncryptedArchiveBuffer();
    const uploadResponse = createResponse();

    await harness.controller.uploadPrivateLibrary(
      createRequest({ buffer, originalname: 'device-data.pijenc' }),
      uploadResponse
    );

    expect(uploadResponse.statusCode).to.equal(200);
    expect(uploadResponse.body).to.include({
      format: PRIVATE_DEVICE_DATA_FORMAT,
      contractVersion: PRIVATE_DEVICE_DATA_CONTRACT_VERSION
    });
    expect(harness.uploaded[0].fileName).to.equal(
      PRIVATE_DEVICE_DATA_FILE_NAME
    );
    expect(harness.uploaded[0].file.mimetype).to.equal(
      PRIVATE_DEVICE_DATA_CONTENT_TYPE
    );

    const downloadResponse = createResponse();
    await harness.controller.downloadPrivateLibrary(
      createRequest(),
      downloadResponse
    );
    expect(downloadResponse.headers['Content-Disposition']).to.equal(
      `attachment; filename="${PRIVATE_DEVICE_DATA_FILE_NAME}"`
    );
    expect(downloadResponse.headers['Content-Type']).to.equal(
      PRIVATE_DEVICE_DATA_CONTENT_TYPE
    );
  });

  it('rejects plaintext device snapshots and requires legacy backups to be re-encrypted', async function() {
    const options = {
      archiveLabel: 'Private device data',
      archiveFileName: PRIVATE_DEVICE_DATA_FILE_NAME,
      archiveFormat: PRIVATE_DEVICE_DATA_FORMAT,
      archiveContractVersion: PRIVATE_DEVICE_DATA_CONTRACT_VERSION,
      archiveContentType: PRIVATE_DEVICE_DATA_CONTENT_TYPE,
      archiveValidator: isEncryptedPrivateDeviceDataBuffer,
      invalidArchiveMessage: 'Encrypted backup required',
      legacyArchiveFormats: [PRIVATE_LIBRARY_LEGACY_FORMAT],
      legacyArchiveErrorCode: 'PRIVATE_DEVICE_DATA_REENCRYPTION_REQUIRED',
      legacyArchiveMessage: 'Re-upload from the original device'
    };
    const harness = createHarness(null, options);
    const uploadResponse = createResponse();
    await harness.controller.uploadPrivateLibrary(
      createRequest({
        buffer: createZipBuffer('plaintext-device-data'),
        originalname: 'device-data.zip'
      }),
      uploadResponse
    );
    expect(uploadResponse.statusCode).to.equal(400);
    expect(uploadResponse.body.message).to.equal('Encrypted backup required');
    expect(harness.uploaded).to.have.length(0);

    const legacyBuffer = createZipBuffer('legacy-device-data');
    const legacyHarness = createHarness(
      {
        user: 'user-1',
        blobName: 'legacy-device-data.zip',
        format: PRIVATE_LIBRARY_LEGACY_FORMAT,
        contractVersion: 1,
        size: legacyBuffer.length,
        sha256: crypto
          .createHash('sha256')
          .update(legacyBuffer)
          .digest('hex'),
        createdAt: 100,
        updatedAt: 200
      },
      options
    );
    const downloadResponse = createResponse();
    await legacyHarness.controller.downloadPrivateLibrary(
      createRequest(),
      downloadResponse
    );
    expect(downloadResponse.statusCode).to.equal(409);
    expect(downloadResponse.body).to.deep.equal({
      code: 'PRIVATE_DEVICE_DATA_REENCRYPTION_REQUIRED',
      message: 'Re-upload from the original device'
    });
  });

  it('atomically replaces the metadata and removes the previous blob', async function() {
    const existingBuffer = createEncryptedArchiveBuffer('existing');
    const harness = createHarness({
      user: 'user-1',
      blobName: 'old-private.zip',
      format: PRIVATE_LIBRARY_FORMAT,
      contractVersion: PRIVATE_LIBRARY_CONTRACT_VERSION,
      size: existingBuffer.length,
      sha256: crypto
        .createHash('sha256')
        .update(existingBuffer)
        .digest('hex'),
      createdAt: 100,
      updatedAt: 100
    });
    const response = createResponse();

    await harness.controller.uploadPrivateLibrary(
      createRequest({
        buffer: createEncryptedArchiveBuffer('replacement'),
        originalname: 'library.pijenc'
      }),
      response
    );

    expect(response.statusCode).to.equal(200);
    expect(response.body.createdAt).to.equal(100);
    expect(harness.removed).to.deep.equal([
      {
        containerName: 'private-test',
        blobName: 'old-private.zip'
      }
    ]);
  });

  it('downloads only an integrity-checked archive through private headers', async function() {
    const buffer = createEncryptedArchiveBuffer('existing');
    const harness = createHarness({
      user: 'user-1',
      blobName: 'private.zip',
      format: PRIVATE_LIBRARY_FORMAT,
      contractVersion: PRIVATE_LIBRARY_CONTRACT_VERSION,
      size: buffer.length,
      sha256: crypto
        .createHash('sha256')
        .update(buffer)
        .digest('hex'),
      createdAt: 100,
      updatedAt: 200
    });
    const response = createResponse();

    await harness.controller.downloadPrivateLibrary(createRequest(), response);

    expect(response.statusCode).to.equal(200);
    expect(response.body.equals(buffer)).to.equal(true);
    expect(response.headers['Cache-Control']).to.equal('private, no-store');
    expect(response.headers['Content-Type']).to.equal(
      PRIVATE_LIBRARY_CONTENT_TYPE
    );
    expect(response.headers['Content-Disposition']).to.match(/^attachment;/);
  });

  it('refuses a private blob that no longer matches stored metadata', async function() {
    const expected = createEncryptedArchiveBuffer('expected');
    const harness = createHarness({
      user: 'user-1',
      blobName: 'private.zip',
      format: PRIVATE_LIBRARY_FORMAT,
      contractVersion: PRIVATE_LIBRARY_CONTRACT_VERSION,
      size: expected.length,
      sha256: crypto
        .createHash('sha256')
        .update(expected)
        .digest('hex'),
      createdAt: 100,
      updatedAt: 200
    });
    harness.setDownloadBuffer(createEncryptedArchiveBuffer('tampered'));
    const response = createResponse();

    await harness.controller.downloadPrivateLibrary(createRequest(), response);

    expect(response.statusCode).to.equal(502);
    expect(response.body.message).to.match(/integrity check/);
  });

  it('deletes the private blob before removing its metadata', async function() {
    const buffer = createEncryptedArchiveBuffer('existing');
    const harness = createHarness({
      user: 'user-1',
      blobName: 'private.zip',
      format: PRIVATE_LIBRARY_FORMAT,
      contractVersion: PRIVATE_LIBRARY_CONTRACT_VERSION,
      size: buffer.length,
      sha256: crypto
        .createHash('sha256')
        .update(buffer)
        .digest('hex'),
      createdAt: 100,
      updatedAt: 200
    });
    const response = createResponse();

    await harness.controller.deletePrivateLibrary(createRequest(), response);

    expect(response.statusCode).to.equal(200);
    expect(response.body).to.deep.equal({ deleted: true });
    expect(harness.removed[0].blobName).to.equal('private.zip');
    expect(harness.getStored()).to.equal(null);
  });
});

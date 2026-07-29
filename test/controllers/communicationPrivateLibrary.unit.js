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
  let downloadBuffer = initial
    ? createEncryptedArchiveBuffer('existing')
    : null;

  const PrivateLibrary = {
    findOne(filter) {
      return createQuery(stored && stored.user === filter.user ? stored : null);
    },
    findOneAndUpdate(filter, update) {
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
    async read() {
      return Buffer.from(downloadBuffer || []);
    },
    async remove(containerName, blobName) {
      removed.push({ containerName, blobName });
      return true;
    }
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
    uploaded
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

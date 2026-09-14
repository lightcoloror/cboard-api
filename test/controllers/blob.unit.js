const { expect } = require('chai');
const mockery = require('mockery');

describe('Azure Blob helper configuration', function() {
  const modulePath = require.resolve('../../api/helpers/blob');
  let capturedContainerOptions;
  let capturedOptions;
  let capturedBlobNames;
  let originalConnectionString;

  beforeEach(function() {
    capturedContainerOptions = null;
    capturedOptions = null;
    capturedBlobNames = [];
    originalConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    delete process.env.AZURE_STORAGE_CONNECTION_STRING;
    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('azure-storage', {
      createBlobService() {
        return {
          createContainerIfNotExists(
            containerName,
            optionsOrCallback,
            callback
          ) {
            const actualCallback =
              typeof optionsOrCallback === 'function'
                ? optionsOrCallback
                : callback;
            capturedContainerOptions =
              typeof optionsOrCallback === 'function'
                ? null
                : optionsOrCallback;
            actualCallback(null, { created: true });
          },
          createBlockBlobFromText(
            containerName,
            blobName,
            buffer,
            options,
            callback
          ) {
            capturedOptions = options;
            capturedBlobNames.push(blobName);
            callback(null, { container: containerName, name: blobName });
          },
          getUrl(containerName, blobName) {
            return `https://storage.example/${containerName}/${blobName}`;
          }
        };
      }
    });
    delete require.cache[modulePath];
  });

  afterEach(function() {
    if (originalConnectionString === undefined) {
      delete process.env.AZURE_STORAGE_CONNECTION_STRING;
    } else {
      process.env.AZURE_STORAGE_CONNECTION_STRING = originalConnectionString;
    }
    mockery.deregisterAll();
    mockery.disable();
    delete require.cache[modulePath];
  });

  it('does not require Azure credentials while the API is starting', function() {
    expect(() => require('../../api/helpers/blob')).not.to.throw();
    expect(
      require('../../api/helpers/blob').isBlobStorageConfigured()
    ).to.equal(false);
  });

  it('returns a clear error only when media upload is requested', async function() {
    const { createBlockBlobFromText } = require('../../api/helpers/blob');

    try {
      await createBlockBlobFromText('test', 'photo.png', {
        buffer: Buffer.from('test'),
        mimetype: 'image/png'
      });
      throw new Error('Expected media upload to reject');
    } catch (error) {
      expect(error.message).to.equal('Azure Blob storage is not configured.');
    }
  });

  it('keeps the long-lived cache setting for public media', async function() {
    process.env.AZURE_STORAGE_CONNECTION_STRING = 'UseDevelopmentStorage=true';
    const {
      createBlockBlobFromText,
      isBlobStorageConfigured
    } = require('../../api/helpers/blob');

    expect(isBlobStorageConfigured()).to.equal(true);
    await createBlockBlobFromText('public', 'photo.png', {
      buffer: Buffer.from('image'),
      mimetype: 'image/png'
    });

    expect(capturedOptions.contentSettings).to.deep.equal({
      contentType: 'image/png',
      cacheControl: 'max-age=31536000'
    });
    expect(capturedContainerOptions).to.equal(null);
  });

  it('keeps private callers on the storage-default private container', async function() {
    process.env.AZURE_STORAGE_CONNECTION_STRING = 'UseDevelopmentStorage=true';
    const { createBlockBlobFromText } = require('../../api/helpers/blob');

    await createBlockBlobFromText(
      'private',
      'library.zip',
      {
        buffer: Buffer.from('archive'),
        mimetype: 'application/zip'
      },
      'account',
      {
        cacheControl: 'private, no-store'
      }
    );

    expect(capturedOptions.contentSettings).to.deep.equal({
      contentType: 'application/zip',
      cacheControl: 'private, no-store'
    });
    expect(capturedContainerOptions).to.equal(null);
  });

  it('uses distinct random blob names for same-second concurrent uploads', async function() {
    process.env.AZURE_STORAGE_CONNECTION_STRING = 'UseDevelopmentStorage=true';
    const { createBlockBlobFromText } = require('../../api/helpers/blob');
    const OriginalDate = global.Date;
    const frozen = new OriginalDate('2026-09-14T09:00:00.000Z').getTime();
    global.Date = class FrozenDate extends OriginalDate {
      constructor(...args) {
        super(args.length ? args[0] : frozen);
      }
      static now() {
        return frozen;
      }
    };
    try {
      await Promise.all([
        createBlockBlobFromText('private', 'care.bin', {
          buffer: Buffer.from('one'),
          mimetype: 'application/octet-stream'
        }, 'care', { cacheControl: 'private, no-store' }),
        createBlockBlobFromText('private', 'care.bin', {
          buffer: Buffer.from('two'),
          mimetype: 'application/octet-stream'
        }, 'care', { cacheControl: 'private, no-store' })
      ]);
    } finally {
      global.Date = OriginalDate;
    }
    expect(capturedBlobNames).to.have.length(2);
    expect(new Set(capturedBlobNames).size).to.equal(2);
    capturedBlobNames.forEach(name => {
      expect(name).to.match(/^care_\d+_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_care\.bin$/);
    });
    expect(capturedOptions.contentSettings).to.deep.equal({
      contentType: 'application/octet-stream',
      cacheControl: 'private, no-store'
    });
  });
});

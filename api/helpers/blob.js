const uuidv4 = require('uuid/v4');
const azure = require('azure-storage');

let blobService = null;

module.exports = {
  createBlockBlobFromText,
  createBlockBlobWithName,
  deleteBlobIfExists,
  getBlobToBuffer,
  isBlobStorageConfigured
};

function isBlobStorageConfigured() {
  return Boolean(
    String(process.env.AZURE_STORAGE_CONNECTION_STRING || '').trim()
  );
}

function getBlobService() {
  if (blobService) {
    return blobService;
  }

  const connectionString = String(
    process.env.AZURE_STORAGE_CONNECTION_STRING || ''
  ).trim();
  if (!isBlobStorageConfigured()) {
    throw new Error('Azure Blob storage is not configured.');
  }

  blobService = azure.createBlobService(connectionString);
  return blobService;
}

function createContainerIfNotExists(service, shareName, containerOptions = {}) {
  return new Promise((resolve, reject) => {
    const callback = function(error, result) {
      if (!error) {
        resolve(result);
      } else {
        reject(error);
      }
    };
    if (Object.keys(containerOptions).length) {
      service.createContainerIfNotExists(shareName, containerOptions, callback);
      return;
    }
    service.createContainerIfNotExists(shareName, callback);
  });
}

function createContentOptions(file, contentSettings = {}, defaults = {}) {
  const options = {};
  const { mimetype } = file;
  if (mimetype && mimetype.length) {
    const cacheMaxAgeInSeconds = 31536000;
    options.contentSettings = {
      contentType: mimetype,
      cacheControl: `max-age=${cacheMaxAgeInSeconds}`
    };
  }
  if (Object.keys(defaults).length || Object.keys(contentSettings).length) {
    options.contentSettings = {
      ...(options.contentSettings || {}),
      ...defaults,
      ...contentSettings
    };
  }
  return options;
}

function assertSafeBlobName(blobName) {
  if (
    typeof blobName !== 'string' ||
    blobName.includes('..') ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(blobName)
  ) {
    throw new TypeError('Invalid blob name.');
  }
}

async function createNamedBlob(containerName, blobName, file, contentSettings, containerOptions) {
  assertSafeBlobName(blobName);
  const service = getBlobService();
  await createContainerIfNotExists(service, containerName, containerOptions);
  const options = createContentOptions(file, contentSettings, {
    cacheControl: 'private, no-store'
  });

  return new Promise((resolve, reject) => {
    service.createBlockBlobFromText(
      containerName,
      blobName,
      file.buffer,
      options,
      function(error, result) {
        if (error) {
          reject(error);
          return;
        }
        resolve([result, service.getUrl(result.container, result.name)]);
      }
    );
  });
}

async function createBlockBlobWithName(
  containerName,
  blobName,
  file,
  contentSettings = {},
  containerOptions = {}
) {
  return createNamedBlob(containerName, blobName, file, contentSettings, containerOptions);
}

// Returns [file:BlobResult, fileUrl:string]
async function createBlockBlobFromText(
  containerName,
  fileName,
  file,
  prefix = '',
  contentSettings = {},
  containerOptions = {}
) {
  const service = getBlobService();
  await createContainerIfNotExists(service, containerName, containerOptions);

  const { buffer } = file;
  const options = createContentOptions(file, contentSettings);

  const ts = Math.round(new Date().getTime() / 1000);
  const finalName = `${prefix}_${ts}_${uuidv4()}_${fileName
    .toLowerCase()
    .trim()}`;

  return new Promise((resolve, reject) => {
    service.createBlockBlobFromText(
      containerName,
      finalName,
      buffer,
      options,
      function(error, file) {
        if (error) {
          reject(error);
          return;
        }

        resolve([file, service.getUrl(file.container, file.name)]);
      }
    );
  });
}

function getBlobToBuffer(containerName, blobName) {
  const service = getBlobService();
  const chunks = [];
  const writable = new (require('stream').Writable)({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });

  return new Promise((resolve, reject) => {
    service.getBlobToStream(containerName, blobName, writable, function(error) {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

function deleteBlobIfExists(containerName, blobName) {
  const service = getBlobService();
  return new Promise((resolve, reject) => {
    service.deleteBlobIfExists(containerName, blobName, function(
      error,
      result
    ) {
      if (error) {
        reject(error);
        return;
      }
      resolve(Boolean(result));
    });
  });
}

const uuidv1 = require('uuid/v1');
const azure = require('azure-storage');

let blobService = null;

module.exports = {
  createBlockBlobFromText,
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

  const { buffer, mimetype } = file;

  const options = {};
  if (mimetype && mimetype.length) {
    const cacheMaxAgeInSeconds = 31536000;
    options.contentSettings = {
      contentType: mimetype,
      cacheControl: `max-age=${cacheMaxAgeInSeconds}`
    };
  }
  if (contentSettings && Object.keys(contentSettings).length) {
    options.contentSettings = {
      ...(options.contentSettings || {}),
      ...contentSettings
    };
  }

  const ts = Math.round(new Date().getTime() / 1000);
  const uuidSuffix = uuidv1()
    .split('-')
    .pop();
  const finalName = `${prefix}_${ts}_${uuidSuffix}_${fileName
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

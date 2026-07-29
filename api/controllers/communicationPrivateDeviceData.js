'use strict';

const CommunicationPrivateDeviceData = require('../models/CommunicationPrivateDeviceData');
const {
  PRIVATE_LIBRARY_LEGACY_FORMAT,
  createCommunicationPrivateLibraryController,
  isEncryptedPrivateArchiveBuffer
} = require('./communicationPrivateLibrary');

const PRIVATE_DEVICE_DATA_FORMAT =
  'picinterpreter-private-device-data-encrypted';
const PRIVATE_DEVICE_DATA_CONTRACT_VERSION = 2;
const PRIVATE_DEVICE_DATA_FILE_NAME =
  'picinterpreter-private-device-data.pijenc';
const PRIVATE_DEVICE_DATA_CONTENT_TYPE = 'application/octet-stream';
const isEncryptedPrivateDeviceDataBuffer =
  isEncryptedPrivateArchiveBuffer;

const controller = createCommunicationPrivateLibraryController({
  PrivateLibrary: CommunicationPrivateDeviceData,
  archiveLabel: 'Private device data',
  archiveFileName: PRIVATE_DEVICE_DATA_FILE_NAME,
  archiveFormat: PRIVATE_DEVICE_DATA_FORMAT,
  archiveContractVersion: PRIVATE_DEVICE_DATA_CONTRACT_VERSION,
  archiveContentType: PRIVATE_DEVICE_DATA_CONTENT_TYPE,
  archiveValidator: isEncryptedPrivateDeviceDataBuffer,
  invalidArchiveMessage:
    'Private device data must be a client-encrypted PicInterpreter backup up to 20 MiB',
  legacyArchiveFormats: [PRIVATE_LIBRARY_LEGACY_FORMAT],
  legacyArchiveErrorCode: 'PRIVATE_DEVICE_DATA_REENCRYPTION_REQUIRED',
  legacyArchiveMessage:
    'This legacy plaintext device backup cannot be restored. Re-upload it from the original device with a recovery password.'
});

module.exports = {
  PRIVATE_DEVICE_DATA_CONTENT_TYPE,
  PRIVATE_DEVICE_DATA_CONTRACT_VERSION,
  PRIVATE_DEVICE_DATA_FILE_NAME,
  PRIVATE_DEVICE_DATA_FORMAT,
  deletePrivateDeviceData: controller.deletePrivateLibrary,
  deletePrivateDeviceDataForUser: controller.deletePrivateLibraryForUser,
  downloadPrivateDeviceData: controller.downloadPrivateLibrary,
  getPrivateDeviceDataMetadata: controller.getPrivateLibraryMetadata,
  isEncryptedPrivateDeviceDataBuffer,
  uploadPrivateDeviceData: controller.uploadPrivateLibrary
};

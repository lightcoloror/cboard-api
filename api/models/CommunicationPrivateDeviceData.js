'use strict';

const createCommunicationPrivateArchiveModel = require('./createCommunicationPrivateArchiveModel');

module.exports = createCommunicationPrivateArchiveModel(
  'CommunicationPrivateDeviceData',
  {
    formats: [
      'picinterpreter-picture-library',
      'picinterpreter-private-device-data-encrypted'
    ]
  }
);

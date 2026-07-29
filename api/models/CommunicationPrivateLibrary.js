'use strict';

const createCommunicationPrivateArchiveModel = require('./createCommunicationPrivateArchiveModel');

module.exports = createCommunicationPrivateArchiveModel(
  'CommunicationPrivateLibrary',
  {
    formats: [
      'picinterpreter-picture-library',
      'picinterpreter-private-picture-library-encrypted'
    ]
  }
);

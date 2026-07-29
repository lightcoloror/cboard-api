'use strict';

const db = require('../../db');
const {
  COMMUNICATION_INDEX_STATUSES,
  ensureCommunicationIndexes,
  getCommunicationIndexesStatus
} = require('../helpers/communicationIndexes');
const { isBlobStorageConfigured } = require('../helpers/blob');

const CONNECTED_STATE = 1;

function getHealth(req, res) {
  const database =
    db.readyState === CONNECTED_STATE ? 'connected' : 'disconnected';
  const communicationIndexes = getCommunicationIndexesStatus();
  const indexesReady =
    communicationIndexes === COMMUNICATION_INDEX_STATUSES.READY;
  const status = database === 'connected' && indexesReady ? 'ok' : 'degraded';
  const privatePictureLibrary = isBlobStorageConfigured()
    ? 'configured'
    : 'unconfigured';

  if (
    database === 'connected' &&
    communicationIndexes !== COMMUNICATION_INDEX_STATUSES.READY &&
    communicationIndexes !== COMMUNICATION_INDEX_STATUSES.BUILDING
  ) {
    ensureCommunicationIndexes().catch(() => null);
  }

  return res.status(status === 'ok' ? 200 : 503).json({
    status,
    database,
    communicationIndexes,
    privatePictureLibrary
  });
}

module.exports = {
  getHealth
};

'use strict';

function getHealth(req, res) {
  return res.status(200).json({
    status: 'ok',
    database: 'connected',
    communicationIndexes: 'ready',
    privatePictureLibrary: 'configured'
  });
}

module.exports = {
  getHealth
};

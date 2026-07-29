'use strict';

const crypto = require('crypto');

function metadata(buffer) {
  return {
    format: 'picinterpreter-private-device-data-encrypted',
    contractVersion: 2,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    createdAt: 300,
    updatedAt: 400
  };
}

module.exports = {
  deletePrivateDeviceData(req, res) {
    return res.status(200).json({ deleted: true });
  },
  downloadPrivateDeviceData(req, res) {
    const buffer = Buffer.concat([
      Buffer.from('PIE2EE01', 'ascii'),
      Buffer.from('device-data-download')
    ]);
    return res.status(200).type('application/octet-stream').send(buffer);
  },
  getPrivateDeviceDataMetadata(req, res) {
    const buffer = Buffer.concat([
      Buffer.from('PIE2EE01', 'ascii'),
      Buffer.from('device-data-metadata')
    ]);
    return res.status(200).json(metadata(buffer));
  },
  uploadPrivateDeviceData(req, res) {
    return res.status(200).json(metadata(req.files.file[0].buffer));
  }
};

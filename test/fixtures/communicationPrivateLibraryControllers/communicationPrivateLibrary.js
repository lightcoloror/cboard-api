'use strict';

const crypto = require('crypto');

function metadata(buffer) {
  return {
    format: 'picinterpreter-private-picture-library-encrypted',
    contractVersion: 2,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    createdAt: 100,
    updatedAt: 200
  };
}

module.exports = {
  deletePrivateLibrary(req, res) {
    return res.status(200).json({ deleted: true });
  },
  downloadPrivateLibrary(req, res) {
    const buffer = Buffer.concat([
      Buffer.from('PIE2EE01', 'ascii'),
      Buffer.from('download')
    ]);
    return res
      .status(200)
      .type('application/octet-stream')
      .send(buffer);
  },
  getPrivateLibraryMetadata(req, res) {
    const buffer = Buffer.concat([
      Buffer.from('PIE2EE01', 'ascii'),
      Buffer.from('metadata')
    ]);
    return res.status(200).json(metadata(buffer));
  },
  uploadPrivateLibrary(req, res) {
    const file = req.files.file[0];
    return res.status(200).json(metadata(file.buffer));
  }
};

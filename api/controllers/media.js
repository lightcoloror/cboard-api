const { createBlockBlobFromText } = require('../helpers/blob');

const BLOB_CONTAINER_NAME = process.env.BLOB_CONTAINER_NAME || 'cblob';
const MAX_MEDIA_UPLOAD_SIZE = 8 * 1024 * 1024;
const SUPPORTED_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/webm'
]);

module.exports = {
  uploadMedia,
  isSupportedMediaUpload
};

function isSupportedMediaUpload(uploadedFile) {
  const mediaType = String(
    uploadedFile && uploadedFile.mimetype ? uploadedFile.mimetype : ''
  )
    .trim()
    .toLowerCase();
  const size = Number(
    uploadedFile && uploadedFile.size !== undefined
      ? uploadedFile.size
      : uploadedFile && uploadedFile.buffer
      ? uploadedFile.buffer.length
      : 0
  );
  return Boolean(
    uploadedFile &&
      SUPPORTED_MEDIA_TYPES.has(mediaType) &&
      Number.isFinite(size) &&
      size > 0 &&
      size <= MAX_MEDIA_UPLOAD_SIZE
  );
}

async function uploadMedia(req, res) {
  let url = null;

  try {
    const uploadedFile =
      req && req.files && Array.isArray(req.files.file)
        ? req.files.file[0]
        : null;
    if (!isSupportedMediaUpload(uploadedFile)) {
      return res.status(400).json({
        message: 'Unsupported, empty, or oversized media file.'
      });
    }
    const [file, fileUrl] = await createBlockBlobFromText(
      BLOB_CONTAINER_NAME,
      uploadedFile.originalname,
      uploadedFile
    );
    url = fileUrl;
  } catch (err) {
    return res.status(500).json({
      message: 'ERROR: Unable to upload media file . ' + err.message
    });
  }
  return res.status(200).json({ url });
}

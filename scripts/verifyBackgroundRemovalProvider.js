'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  createCommunicationBackgroundRemovalProvider
} = require('../api/helpers/communicationBackgroundRemovalProvider');

const MIME_TYPES_BY_EXTENSION = Object.freeze({
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
});

function requireSmokeImagePath() {
  const imagePath = String(
    process.env.BACKGROUND_REMOVAL_SMOKE_IMAGE || ''
  ).trim();
  if (!imagePath) {
    throw new Error(
      'Set BACKGROUND_REMOVAL_SMOKE_IMAGE to a local JPEG, PNG, or WebP image'
    );
  }
  return path.resolve(imagePath);
}

async function main() {
  const imagePath = requireSmokeImagePath();
  const mimetype =
    MIME_TYPES_BY_EXTENSION[path.extname(imagePath).toLowerCase()];
  if (!mimetype) {
    throw new Error('Smoke image must be JPEG, PNG, or WebP');
  }

  const provider = createCommunicationBackgroundRemovalProvider();
  if (!provider) {
    throw new Error(
      'Configure BACKGROUND_REMOVAL_PROVIDER before running this verification'
    );
  }

  const startedAt = Date.now();
  const result = await provider.removeBackground({
    buffer: fs.readFileSync(imagePath),
    mimetype,
    originalname: path.basename(imagePath)
  });
  const output = Buffer.from(result.imageBase64, 'base64');

  console.log(
    JSON.stringify(
      {
        ok: true,
        provider: result.provider,
        mimeType: result.mimeType,
        width: result.width,
        height: result.height,
        outputBytes: output.length,
        sha256: crypto
          .createHash('sha256')
          .update(output)
          .digest('hex'),
        sourceStored: result.sourceStored,
        originalRetained: result.originalRetained,
        elapsedMs: Date.now() - startedAt
      },
      null,
      2
    )
  );
}

main().catch(error => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        message: error.message || String(error),
        status: error.status || null
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});

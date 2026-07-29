'use strict';

const sharp = require('sharp');

const MAX_PICTOGRAM_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_PICTOGRAM_INPUT_PIXELS = 16 * 1024 * 1024;
const PICTOGRAM_OUTPUT_SIZE = 300;
const PNG_SIGNATURE = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a
]);

function isPngBuffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

async function normalizePublicPictogramImage(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (!input.length || input.length > MAX_PICTOGRAM_IMAGE_BYTES) {
    throw new Error('Invalid pictogram image');
  }

  let output;
  try {
    output = await sharp(input, {
      animated: false,
      density: 144,
      failOn: 'warning',
      limitInputChannels: 4,
      limitInputPixels: MAX_PICTOGRAM_INPUT_PIXELS,
      pages: 1,
      sequentialRead: true,
      unlimited: false
    })
      .rotate()
      .resize({
        width: PICTOGRAM_OUTPUT_SIZE,
        height: PICTOGRAM_OUTPUT_SIZE,
        fit: 'inside',
        withoutEnlargement: false
      })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new Error('Invalid pictogram image');
  }

  if (
    !output ||
    !output.info ||
    output.info.format !== 'png' ||
    !isPngBuffer(output.data) ||
    !output.data.length ||
    output.data.length > MAX_PICTOGRAM_IMAGE_BYTES
  ) {
    throw new Error('Invalid pictogram image');
  }

  return {
    buffer: output.data,
    contentType: 'image/png'
  };
}

module.exports = {
  MAX_PICTOGRAM_IMAGE_BYTES,
  MAX_PICTOGRAM_INPUT_PIXELS,
  PICTOGRAM_OUTPUT_SIZE,
  isPngBuffer,
  normalizePublicPictogramImage
};

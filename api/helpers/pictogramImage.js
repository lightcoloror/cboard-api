'use strict';

const sharp = require('sharp');

const MAX_PICTOGRAM_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_PICTOGRAM_INPUT_PIXELS = 16 * 1024 * 1024;
const PICTOGRAM_OUTPUT_SIZE = 300;
const GIF89A_SIGNATURE = Buffer.from('GIF89a', 'ascii');
const MAX_ANIMATED_GIF_BYTES = 128 * 1024;
const MAX_ANIMATED_GIF_FRAMES = 8;
const MAX_ANIMATED_GIF_DIMENSION = 300;
const MIN_ANIMATED_GIF_FRAME_DELAY_MS = 250;
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

function isGif89aBuffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= GIF89A_SIGNATURE.length &&
    buffer.subarray(0, GIF89A_SIGNATURE.length).equals(GIF89A_SIGNATURE)
  );
}

async function validateAnimatedGifBuffer(value, options = {}) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (!isGif89aBuffer(input)) {
    return { valid: false, reason: 'not_gif89a' };
  }

  const maxBytes =
    Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : MAX_ANIMATED_GIF_BYTES;
  if (input.length > maxBytes) {
    return { valid: false, reason: 'too_large_bytes', bytes: input.length };
  }

  const maxFrames =
    Number.isFinite(options.maxFrames) && options.maxFrames > 0
      ? Math.floor(options.maxFrames)
      : MAX_ANIMATED_GIF_FRAMES;
  const maxDimension =
    Number.isFinite(options.maxDimension) && options.maxDimension > 0
      ? Math.floor(options.maxDimension)
      : MAX_ANIMATED_GIF_DIMENSION;
  const minFrameDelayMs =
    Number.isFinite(options.minFrameDelayMs) && options.minFrameDelayMs >= 0
      ? options.minFrameDelayMs
      : MIN_ANIMATED_GIF_FRAME_DELAY_MS;

  let meta;
  try {
    meta = await sharp(input, {
      animated: true,
      failOn: 'warning',
      limitInputPixels: MAX_PICTOGRAM_INPUT_PIXELS,
      sequentialRead: false,
      unlimited: false
    }).metadata();
  } catch (error) {
    return { valid: false, reason: 'decode_failed' };
  }

  if (!meta || meta.format !== 'gif') {
    return { valid: false, reason: 'decode_failed' };
  }

  const pages = Number(meta.pages || 1);
  if (!Number.isFinite(pages) || pages < 2) {
    return { valid: false, reason: 'not_animated', pages };
  }
  if (pages > maxFrames) {
    return { valid: false, reason: 'too_many_frames', pages };
  }

  const width = Number(meta.width || 0);
  const frameHeight = Number(meta.pageHeight || meta.height || 0);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(frameHeight) ||
    width <= 0 ||
    frameHeight <= 0 ||
    width > maxDimension ||
    frameHeight > maxDimension
  ) {
    return {
      valid: false,
      reason: 'dimensions_exceeded',
      width,
      height: frameHeight
    };
  }

  if (
    Array.isArray(meta.delay) &&
    meta.delay.some(delay => Number(delay) < minFrameDelayMs)
  ) {
    return {
      valid: false,
      reason: 'frame_delay_too_fast',
      delay: meta.delay
    };
  }

  try {
    await sharp(input, {
      animated: true,
      pages: -1,
      failOn: 'warning',
      limitInputPixels: MAX_PICTOGRAM_INPUT_PIXELS,
      sequentialRead: false,
      unlimited: false
    })
      .raw()
      .toBuffer();
  } catch (error) {
    return { valid: false, reason: 'decode_failed' };
  }

  return {
    valid: true,
    pages,
    width,
    height: frameHeight,
    delay: meta.delay || [],
    loop: meta.loop || 0,
    bytes: input.length
  };
}

async function normalizePublicPictogramImage(value, options = {}) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (!input.length || input.length > MAX_PICTOGRAM_IMAGE_BYTES) {
    throw new Error('Invalid pictogram image');
  }

  if (options && options.allowAnimatedGif === true && isGif89aBuffer(input)) {
    const validation = await validateAnimatedGifBuffer(input, options);
    if (validation.valid) {
      return {
        buffer: Buffer.from(input),
        contentType: 'image/gif',
        animated: true,
        pages: validation.pages,
        width: validation.width,
        height: validation.height
      };
    }
    if (
      validation.reason !== 'not_animated' &&
      options.fallbackToStaticPng !== true
    ) {
      throw new Error(`Invalid animated pictogram GIF: ${validation.reason}`);
    }
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

async function normalizeAnimatedPictogramImage(value, options = {}) {
  return normalizePublicPictogramImage(value, {
    ...options,
    allowAnimatedGif: true
  });
}

module.exports = {
  GIF89A_SIGNATURE,
  MAX_ANIMATED_GIF_BYTES,
  MAX_ANIMATED_GIF_DIMENSION,
  MAX_ANIMATED_GIF_FRAMES,
  MAX_PICTOGRAM_IMAGE_BYTES,
  MAX_PICTOGRAM_INPUT_PIXELS,
  MIN_ANIMATED_GIF_FRAME_DELAY_MS,
  PICTOGRAM_OUTPUT_SIZE,
  isGif89aBuffer,
  isPngBuffer,
  normalizeAnimatedPictogramImage,
  normalizePublicPictogramImage,
  validateAnimatedGifBuffer
};

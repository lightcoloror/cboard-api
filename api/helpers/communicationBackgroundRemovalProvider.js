'use strict';

const axios = require('axios');

const MAX_BACKGROUND_REMOVAL_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_BACKGROUND_REMOVAL_OUTPUT_BYTES = 4 * 1024 * 1024;
const BACKGROUND_REMOVAL_IMAGE_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp'
]);
const BACKGROUND_REMOVAL_PROVIDERS = Object.freeze([
  'rembg',
  'removebg'
]);
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

function createHttpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function boundedTimeout(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout)) return 30000;
  return Math.max(5000, Math.min(60000, Math.round(timeout)));
}

function normalizeEndpoint(value, fallback) {
  const endpoint = String(value || fallback || '')
    .trim()
    .replace(/\/+$/, '');
  if (!endpoint) return '';

  try {
    const parsed = new URL(endpoint);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? endpoint
      : '';
  } catch (error) {
    return '';
  }
}

function resolveBackgroundRemovalConfiguration(env = process.env) {
  const provider = String(env.BACKGROUND_REMOVAL_PROVIDER || '')
    .trim()
    .toLowerCase();
  if (!BACKGROUND_REMOVAL_PROVIDERS.includes(provider)) return null;

  const endpoint = normalizeEndpoint(
    env.BACKGROUND_REMOVAL_API_URL,
    provider === 'removebg'
      ? 'https://api.remove.bg/v1.0/removebg'
      : 'http://127.0.0.1:7000/api/remove'
  );
  const apiKey = String(env.BACKGROUND_REMOVAL_API_KEY || '').trim();
  if (!endpoint || (provider === 'removebg' && !apiKey)) return null;

  return {
    provider,
    endpoint,
    apiKey,
    timeoutMs: boundedTimeout(env.BACKGROUND_REMOVAL_TIMEOUT_MS)
  };
}

function validateInputImage(file) {
  const buffer =
    file && Buffer.isBuffer(file.buffer) ? file.buffer : null;
  if (!buffer || !buffer.length) {
    throw createHttpError('image is required', 400);
  }

  const mimetype = String(file.mimetype || '').trim().toLowerCase();
  if (!BACKGROUND_REMOVAL_IMAGE_TYPES.includes(mimetype)) {
    throw createHttpError(
      'Unsupported background removal image type',
      415
    );
  }
  if (buffer.length > MAX_BACKGROUND_REMOVAL_INPUT_BYTES) {
    throw createHttpError(
      'Background removal image exceeds 2 MiB',
      413
    );
  }

  return { buffer, mimetype };
}

function appendMultipartField(chunks, boundary, name, value) {
  chunks.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`
    )
  );
}

function appendMultipartFile(
  chunks,
  boundary,
  name,
  image
) {
  const extension =
    image.mimetype === 'image/png'
      ? 'png'
      : image.mimetype === 'image/webp'
        ? 'webp'
        : 'jpg';
  chunks.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"; ` +
        `filename="communication-image.${extension}"\r\n` +
        `Content-Type: ${image.mimetype}\r\n\r\n`
    ),
    image.buffer,
    Buffer.from('\r\n')
  );
}

function buildMultipartRequest(image, configuration, boundary) {
  const chunks = [];
  appendMultipartFile(
    chunks,
    boundary,
    configuration.provider === 'removebg' ? 'image_file' : 'file',
    image
  );
  if (configuration.provider === 'removebg') {
    appendMultipartField(chunks, boundary, 'size', 'auto');
    appendMultipartField(chunks, boundary, 'format', 'png');
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function validateTransparentPng(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
  if (!buffer.length || buffer.length > MAX_BACKGROUND_REMOVAL_OUTPUT_BYTES) {
    throw createHttpError(
      'Background removal output is empty or exceeds 4 MiB',
      502
    );
  }
  if (
    buffer.length < 45 ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw createHttpError(
      'Background removal provider did not return a PNG',
      502
    );
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let hasTransparency = false;
  let hasEnd = false;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > buffer.length) {
      throw createHttpError(
        'Background removal provider returned a damaged PNG',
        502
      );
    }

    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR' && length === 13) {
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
      const colorType = buffer[offset + 17];
      hasTransparency = colorType === 4 || colorType === 6;
    }
    if (type === 'tRNS') hasTransparency = true;
    if (type === 'IEND') {
      hasEnd = true;
      break;
    }
    offset = chunkEnd;
  }

  if (
    !width ||
    !height ||
    width > 8192 ||
    height > 8192 ||
    width * height > 32000000 ||
    !hasEnd
  ) {
    throw createHttpError(
      'Background removal provider returned an invalid PNG',
      502
    );
  }
  if (!hasTransparency) {
    throw createHttpError(
      'Background removal output has no transparency',
      502
    );
  }

  return { buffer, width, height };
}

function createCommunicationBackgroundRemovalProvider(options = {}) {
  const configuration =
    options.configuration ||
    resolveBackgroundRemovalConfiguration(options.env);
  if (!configuration) return null;

  const request = options.request || axios;
  const boundaryFactory =
    options.boundaryFactory ||
    (() =>
      `----cboard-background-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2)}`);

  return {
    provider: configuration.provider,
    endpoint: configuration.endpoint,

    async removeBackground(file) {
      const image = validateInputImage(file);
      const boundary = boundaryFactory();
      const body = buildMultipartRequest(
        image,
        configuration,
        boundary
      );
      const headers = {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      };
      if (configuration.apiKey) {
        headers['X-Api-Key'] = configuration.apiKey;
      }

      let response;
      try {
        response = await request({
          method: 'post',
          url: configuration.endpoint,
          data: body,
          headers,
          responseType: 'arraybuffer',
          timeout: configuration.timeoutMs,
          maxBodyLength: MAX_BACKGROUND_REMOVAL_INPUT_BYTES + 4096,
          maxContentLength: MAX_BACKGROUND_REMOVAL_OUTPUT_BYTES
        });
      } catch (error) {
        const upstreamStatus =
          error && error.response && Number(error.response.status);
        throw createHttpError(
          upstreamStatus === 429
            ? 'Background removal rate limit reached'
            : 'Background removal provider request failed',
          upstreamStatus === 429
            ? 429
            : error && error.code === 'ECONNABORTED'
              ? 504
              : 502
        );
      }

      const output = validateTransparentPng(
        response && response.data
      );
      return {
        imageBase64: output.buffer.toString('base64'),
        mimeType: 'image/png',
        width: output.width,
        height: output.height,
        provider: configuration.provider,
        sourceStored: false,
        originalRetained: true
      };
    }
  };
}

module.exports = {
  BACKGROUND_REMOVAL_IMAGE_TYPES,
  BACKGROUND_REMOVAL_PROVIDERS,
  MAX_BACKGROUND_REMOVAL_INPUT_BYTES,
  MAX_BACKGROUND_REMOVAL_OUTPUT_BYTES,
  buildMultipartRequest,
  createCommunicationBackgroundRemovalProvider,
  resolveBackgroundRemovalConfiguration,
  validateInputImage,
  validateTransparentPng
};

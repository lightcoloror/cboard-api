'use strict';

const { asr } = require('tencentcloud-sdk-nodejs-asr');
const {
  createCommunicationVolcengineAsrProvider,
  resolveVolcengineAsrConfig
} = require('./communicationVolcengineAsrProvider');

const MAX_DIALECT_ASR_INPUT_BYTES = 3 * 1024 * 1024;
const MAX_DIALECT_ASR_TEXT_LENGTH = 120;
const DIALECT_ASR_ENGINE = '16k_yue';
const DIALECT_ASR_PROVIDER = 'tencentcloud';
const VOLCENGINE_DIALECT_ASR_PROVIDER = 'volcengine';
const DIALECT_ASR_AUDIO_TYPES = Object.freeze({
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg-opus',
  'audio/pcm': 'pcm',
  'audio/vnd.wave': 'wav',
  'audio/wav': 'wav',
  'audio/x-m4a': 'm4a',
  'audio/x-pcm': 'pcm',
  'audio/x-wav': 'wav'
});

function createHttpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DIALECT_ASR_TEXT_LENGTH);
}

function normalizeMimeType(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .split(';')[0];
}

function hasAudioSignature(buffer, format) {
  if (format === 'pcm') return true;
  if (format === 'mp3') {
    return (
      buffer.subarray(0, 3).toString('ascii') === 'ID3' ||
      (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
    );
  }
  if (format === 'm4a') {
    return (
      buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp'
    );
  }
  if (format === 'wav') {
    return (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WAVE'
    );
  }
  if (format === 'ogg-opus') {
    return buffer.subarray(0, 4).toString('ascii') === 'OggS';
  }
  if (format === 'aac') {
    return (
      buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0
    );
  }
  if (format === 'amr') {
    return buffer.subarray(0, 6).toString('ascii') === '#!AMR\n';
  }
  return false;
}

function validateDialectAudio(file) {
  const buffer = file && Buffer.isBuffer(file.buffer) ? file.buffer : null;
  if (!buffer || !buffer.length) {
    throw createHttpError('audio is required', 400);
  }
  if (buffer.length > MAX_DIALECT_ASR_INPUT_BYTES) {
    throw createHttpError('Dialect audio exceeds 3 MiB', 413);
  }

  const mimeType = normalizeMimeType(file.mimetype);
  const voiceFormat = DIALECT_ASR_AUDIO_TYPES[mimeType];
  if (!voiceFormat || !hasAudioSignature(buffer, voiceFormat)) {
    throw createHttpError('Unsupported dialect audio type', 415);
  }
  return { buffer, mimeType, voiceFormat };
}

function normalizeTimeoutSeconds(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout)) return 30;
  return Math.max(5, Math.min(60, Math.round(timeout)));
}

function resolveDialectAsrConfiguration(env = process.env) {
  const provider = String(env.COMMUNICATION_DIALECT_ASR_PROVIDER || '')
    .trim()
    .toLowerCase();
  if (provider === VOLCENGINE_DIALECT_ASR_PROVIDER) {
    return resolveVolcengineAsrConfig(env);
  }
  if (provider !== DIALECT_ASR_PROVIDER) return null;

  const secretId = String(
    env.COMMUNICATION_TENCENTCLOUD_ASR_SECRET_ID ||
      env.TENCENTCLOUD_SECRET_ID ||
      ''
  ).trim();
  const secretKey = String(
    env.COMMUNICATION_TENCENTCLOUD_ASR_SECRET_KEY ||
      env.TENCENTCLOUD_SECRET_KEY ||
      ''
  ).trim();
  if (!secretId || !secretKey) return null;

  return {
    provider,
    secretId,
    secretKey,
    engine: DIALECT_ASR_ENGINE,
    region: String(env.COMMUNICATION_TENCENTCLOUD_ASR_REGION || '').trim(),
    timeoutSeconds: normalizeTimeoutSeconds(
      env.COMMUNICATION_DIALECT_ASR_TIMEOUT_SECONDS
    )
  };
}

function mapProviderError(error) {
  const code = String((error && (error.code || error.Code)) || '');
  const message = String((error && error.message) || '');
  if (/RequestLimitExceeded/i.test(code)) {
    return createHttpError('Dialect ASR rate limit reached', 429);
  }
  if (/Audio|Voice|Data/i.test(code)) {
    return createHttpError('Dialect ASR rejected the audio', 422);
  }
  if (/timeout/i.test(code + ' ' + message)) {
    return createHttpError('Dialect ASR request timed out', 504);
  }
  return createHttpError('Dialect ASR provider request failed', 502);
}

function createDialectAsrClient(configuration, sdk) {
  return new sdk.Client({
    credential: {
      secretId: configuration.secretId,
      secretKey: configuration.secretKey
    },
    region: configuration.region,
    profile: {
      signMethod: 'TC3-HMAC-SHA256',
      httpProfile: {
        endpoint: 'asr.tencentcloudapi.com',
        reqTimeout: configuration.timeoutSeconds
      }
    }
  });
}

function createCommunicationDialectAsrProvider(options = {}) {
  const configuration =
    options.configuration || resolveDialectAsrConfiguration(options.env);
  if (!configuration) return null;

  if (configuration.provider === VOLCENGINE_DIALECT_ASR_PROVIDER) {
    return createCommunicationVolcengineAsrProvider({
      configuration,
      fetchImpl: options.fetchImpl,
      randomUUIDImpl: options.randomUUIDImpl,
      validateAudio: validateDialectAudio
    });
  }

  const sdk = options.sdk || asr.v20190614;
  const client = options.client || createDialectAsrClient(configuration, sdk);

  return {
    provider: 'tencentcloud-asr',
    engine: configuration.engine,

    async recognize(file) {
      const audio = validateDialectAudio(file);
      const data = audio.buffer.toString('base64');
      if (Buffer.byteLength(data, 'ascii') > MAX_DIALECT_ASR_INPUT_BYTES) {
        throw createHttpError(
          'Dialect audio exceeds the Tencent encoded 3 MiB limit',
          413
        );
      }
      let response;
      try {
        response = await client.SentenceRecognition({
          EngSerViceType: configuration.engine,
          SourceType: 1,
          VoiceFormat: audio.voiceFormat,
          Data: data,
          DataLen: audio.buffer.length,
          FilterDirty: 0,
          FilterModal: 0,
          FilterPunc: 0,
          ConvertNumMode: 1,
          WordInfo: 0
        });
      } catch (error) {
        throw mapProviderError(error);
      }

      const text = normalizeText(response && response.Result);
      if (!text) {
        throw createHttpError('Dialect ASR did not recognize speech', 422);
      }
      const duration = Number(response && response.AudioDuration);
      return {
        text,
        dialect: 'cantonese',
        engine: configuration.engine,
        provider: 'tencentcloud-asr',
        audioDurationMs:
          Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : 0,
        audioStored: false,
        providerProcessing: true
      };
    }
  };
}

module.exports = {
  DIALECT_ASR_AUDIO_TYPES,
  DIALECT_ASR_ENGINE,
  DIALECT_ASR_PROVIDER,
  MAX_DIALECT_ASR_INPUT_BYTES,
  MAX_DIALECT_ASR_TEXT_LENGTH,
  VOLCENGINE_DIALECT_ASR_PROVIDER,
  createCommunicationDialectAsrProvider,
  createDialectAsrClient,
  hasAudioSignature,
  mapProviderError,
  normalizeTimeoutSeconds,
  resolveDialectAsrConfiguration,
  validateDialectAudio
};

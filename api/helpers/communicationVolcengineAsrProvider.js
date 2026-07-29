'use strict';

const { randomUUID } = require('crypto');

const DEFAULT_VOLCENGINE_ASR_BASE_URL =
  'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
const DEFAULT_VOLCENGINE_ASR_RESOURCE_ID = 'volc.bigasr.auc_turbo';
const VOLCENGINE_ASR_ENGINE = 'bigmodel';
const MAX_VOLCENGINE_ASR_RESPONSE_BYTES = 1024 * 1024;
const MAX_VOLCENGINE_ASR_AUDIO_DURATION_MS = 60 * 1000;
const VOLCENGINE_ASR_AUDIO_FORMATS = Object.freeze(['mp3', 'ogg-opus', 'wav']);

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeBaseUrl(value) {
  const candidate = normalizeText(value) || DEFAULT_VOLCENGINE_ASR_BASE_URL;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.toString().replace(/\/+$/, '');
  } catch (error) {
    return '';
  }
}

function normalizeTimeoutMs(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 30000;
  return Math.max(5000, Math.min(60000, Math.round(seconds * 1000)));
}

function createProviderError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function resolveVolcengineAsrConfig(env = process.env) {
  const apiKey = normalizeText(env.VOLCENGINE_ASR_API_KEY);
  const appKey = normalizeText(env.VOLCENGINE_ASR_APP_KEY);
  const accessKey = normalizeText(env.VOLCENGINE_ASR_ACCESS_KEY);
  if (!apiKey && (!appKey || !accessKey)) return null;

  const baseUrl = normalizeBaseUrl(env.VOLCENGINE_ASR_BASE_URL);
  if (!baseUrl) return null;

  return {
    provider: 'volcengine',
    apiKey,
    appKey,
    accessKey,
    baseUrl,
    resourceId:
      normalizeText(env.VOLCENGINE_ASR_RESOURCE_ID) ||
      DEFAULT_VOLCENGINE_ASR_RESOURCE_ID,
    engine: VOLCENGINE_ASR_ENGINE,
    timeoutMs: normalizeTimeoutMs(env.COMMUNICATION_DIALECT_ASR_TIMEOUT_SECONDS)
  };
}

function getResponseHeader(response, name) {
  if (!response || !response.headers) return '';
  if (typeof response.headers.get === 'function') {
    return normalizeText(response.headers.get(name));
  }
  const target = name.toLowerCase();
  const entry = Object.entries(response.headers).find(
    ([key]) => key.toLowerCase() === target
  );
  return entry ? normalizeText(entry[1]) : '';
}

async function readBoundedResponseText(response) {
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_VOLCENGINE_ASR_RESPONSE_BYTES) {
    throw createProviderError(502, 'Dialect ASR provider response is invalid');
  }
  return body;
}

function parseProviderResponse(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch (error) {
    return null;
  }
}

function mapVolcengineAsrStatus(statusCode, httpStatus) {
  if (Number(httpStatus) === 429) {
    return createProviderError(429, 'Dialect ASR rate limit reached');
  }
  if (Number(httpStatus) >= 500) {
    return createProviderError(
      503,
      'Dialect ASR provider is temporarily unavailable'
    );
  }
  if (statusCode === '20000003' || statusCode === '45000002') {
    return createProviderError(422, 'Dialect ASR did not recognize speech');
  }
  if (statusCode === '45000001' || statusCode === '45000151') {
    return createProviderError(422, 'Dialect ASR rejected the audio');
  }
  if (statusCode === '55000031') {
    return createProviderError(
      503,
      'Dialect ASR provider is temporarily unavailable'
    );
  }
  return createProviderError(502, 'Dialect ASR provider request failed');
}

function mapVolcengineAsrError(error) {
  if (error && Number(error.status) >= 400 && Number(error.status) < 600) {
    return error;
  }
  const detail = [
    error && error.name,
    error && error.code,
    error && error.message
  ]
    .filter(Boolean)
    .join(' ');
  if (/abort|timeout/i.test(detail)) {
    return createProviderError(504, 'Dialect ASR request timed out');
  }
  return createProviderError(502, 'Dialect ASR provider request failed');
}

function createAuthenticationHeaders(configuration) {
  if (configuration.apiKey) {
    return { 'X-Api-Key': configuration.apiKey };
  }
  return {
    'X-Api-App-Key': configuration.appKey,
    'X-Api-Access-Key': configuration.accessKey
  };
}

function createCommunicationVolcengineAsrProvider({
  configuration,
  fetchImpl = global.fetch,
  randomUUIDImpl = randomUUID,
  validateAudio
} = {}) {
  if (
    !configuration ||
    typeof fetchImpl !== 'function' ||
    typeof validateAudio !== 'function'
  ) {
    return null;
  }

  return {
    provider: 'volcengine-bigasr',
    engine: configuration.engine,

    async recognize(file) {
      const audio = validateAudio(file);
      if (!VOLCENGINE_ASR_AUDIO_FORMATS.includes(audio.voiceFormat)) {
        throw createProviderError(415, 'Unsupported dialect audio type');
      }

      let response;
      const requestId = randomUUIDImpl();
      try {
        response = await fetchImpl(configuration.baseUrl, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...createAuthenticationHeaders(configuration),
            'X-Api-Resource-Id': configuration.resourceId,
            'X-Api-Request-Id': requestId,
            'X-Api-Sequence': '-1'
          },
          body: JSON.stringify({
            user: {
              uid: requestId
            },
            audio: {
              data: audio.buffer.toString('base64')
            },
            request: {
              model_name: configuration.engine,
              enable_itn: true,
              enable_punc: true
            }
          }),
          signal: AbortSignal.timeout(configuration.timeoutMs)
        });
      } catch (error) {
        throw mapVolcengineAsrError(error);
      }

      const statusCode = getResponseHeader(response, 'X-Api-Status-Code');
      if (!response || !response.ok || statusCode !== '20000000') {
        throw mapVolcengineAsrStatus(statusCode, response && response.status);
      }

      let payload;
      try {
        payload = parseProviderResponse(
          await readBoundedResponseText(response)
        );
      } catch (error) {
        throw mapVolcengineAsrError(error);
      }
      if (!payload) {
        throw createProviderError(
          502,
          'Dialect ASR provider response is invalid'
        );
      }
      const text = normalizeText(payload.result && payload.result.text)
        .replace(/\u0000/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 120);
      if (!text) {
        throw createProviderError(422, 'Dialect ASR did not recognize speech');
      }

      const duration = Number(
        (payload && payload.audio_info && payload.audio_info.duration) ||
          (payload &&
            payload.result &&
            payload.result.additions &&
            payload.result.additions.duration)
      );
      if (
        Number.isFinite(duration) &&
        (duration < 0 || duration > MAX_VOLCENGINE_ASR_AUDIO_DURATION_MS)
      ) {
        throw createProviderError(422, 'Dialect ASR rejected the audio');
      }

      return {
        text,
        dialect: 'cantonese',
        engine: configuration.engine,
        provider: 'volcengine-bigasr',
        audioDurationMs:
          Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : 0,
        audioStored: false,
        providerProcessing: true
      };
    }
  };
}

module.exports = {
  DEFAULT_VOLCENGINE_ASR_BASE_URL,
  DEFAULT_VOLCENGINE_ASR_RESOURCE_ID,
  MAX_VOLCENGINE_ASR_AUDIO_DURATION_MS,
  MAX_VOLCENGINE_ASR_RESPONSE_BYTES,
  VOLCENGINE_ASR_AUDIO_FORMATS,
  VOLCENGINE_ASR_ENGINE,
  createCommunicationVolcengineAsrProvider,
  getResponseHeader,
  mapVolcengineAsrError,
  mapVolcengineAsrStatus,
  normalizeTimeoutMs,
  parseProviderResponse,
  readBoundedResponseText,
  resolveVolcengineAsrConfig
};

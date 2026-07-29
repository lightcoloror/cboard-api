'use strict';

const { randomUUID } = require('crypto');

const DEFAULT_VOLCENGINE_TTS_BASE_URL =
  'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse';
const DEFAULT_VOLCENGINE_TTS_RESOURCE_ID = 'seed-tts-2.0';
const DEFAULT_VOLCENGINE_TTS_VOICE = 'zh_female_vv_uranus_bigtts';
const DEFAULT_VOLCENGINE_TTS_TIMEOUT_MS = 25000;
const MAX_VOLCENGINE_TTS_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_VOLCENGINE_TTS_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_VOLCENGINE_TTS_TEXT_LENGTH = 300;
const MAX_VOLCENGINE_TTS_VOICES = 20;

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeBaseUrl(value) {
  const candidate = normalizeText(value) || DEFAULT_VOLCENGINE_TTS_BASE_URL;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.toString().replace(/\/+$/, '');
  } catch (error) {
    return '';
  }
}

function normalizeTimeout(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout)) return DEFAULT_VOLCENGINE_TTS_TIMEOUT_MS;
  return Math.max(1000, Math.min(60000, Math.round(timeout)));
}

function normalizeRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return 1;
  return Math.max(0.5, Math.min(2, rate));
}

function normalizeVoice(value, fallback = DEFAULT_VOLCENGINE_TTS_VOICE) {
  return (normalizeText(value) || fallback).slice(0, 80);
}

function normalizeVoiceList(value, defaultVoice) {
  const seen = new Set();
  return [defaultVoice, ...String(value || '').split(',')]
    .map(item => normalizeVoice(item, ''))
    .filter(item => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    })
    .slice(0, MAX_VOLCENGINE_TTS_VOICES);
}

function createProviderError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function resolveVolcengineTtsConfig(env = process.env) {
  const apiKey = normalizeText(env.VOLCENGINE_TTS_API_KEY);
  if (!apiKey) return null;

  const baseUrl = normalizeBaseUrl(env.VOLCENGINE_TTS_BASE_URL);
  if (!baseUrl) return null;

  const voice = normalizeVoice(env.VOLCENGINE_TTS_VOICE);
  return {
    apiKey,
    baseUrl,
    resourceId:
      normalizeText(env.VOLCENGINE_TTS_RESOURCE_ID) ||
      DEFAULT_VOLCENGINE_TTS_RESOURCE_ID,
    voice,
    voices: normalizeVoiceList(env.VOLCENGINE_TTS_VOICES, voice),
    timeoutMs: normalizeTimeout(
      env.VOLCENGINE_TTS_TIMEOUT_MS || env.AI_TTS_TIMEOUT_MS
    )
  };
}

function parseVolcengineTtsSse(body) {
  const frames = [];
  String(body || '')
    .split(/\r?\n/)
    .forEach(line => {
      const value = line.trim();
      if (!value.startsWith('data:')) return;
      const json = value.slice('data:'.length).trim();
      if (!json || json === '[DONE]') return;
      try {
        const parsed = JSON.parse(json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          frames.push(parsed);
        }
      } catch (error) {
        throw createProviderError(
          502,
          'Speech provider returned invalid audio'
        );
      }
    });
  return frames;
}

function decodeAudioChunk(value) {
  const encoded = normalizeText(value);
  if (
    !encoded ||
    encoded.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    throw createProviderError(502, 'Speech provider returned invalid audio');
  }
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  const data = Buffer.from(padded, 'base64');
  if (!data.length) {
    throw createProviderError(502, 'Speech provider returned invalid audio');
  }
  return data;
}

async function readBoundedResponseText(response) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let body = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_VOLCENGINE_TTS_RESPONSE_BYTES) {
          throw createProviderError(
            502,
            'Speech provider returned invalid audio'
          );
        }
        body += decoder.decode(value, { stream: true });
      }
      return body + decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }

  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_VOLCENGINE_TTS_RESPONSE_BYTES) {
    throw createProviderError(502, 'Speech provider returned invalid audio');
  }
  return body;
}

function mapVolcengineTtsError(error) {
  if (error && Number(error.status) >= 400 && Number(error.status) < 600) {
    return error;
  }
  const detail = [error && error.name, error && error.code, error && error.message]
    .filter(Boolean)
    .join(' ');
  if (/abort|timeout/i.test(detail)) {
    return createProviderError(504, 'Speech provider request timed out');
  }
  if (/quota|concurr|rate.?limit/i.test(detail)) {
    return createProviderError(429, 'Speech provider rate limit reached');
  }
  return createProviderError(502, 'Speech provider request failed');
}

function createCommunicationVolcengineTtsProvider({
  env = process.env,
  fetchImpl = global.fetch
} = {}) {
  const config = resolveVolcengineTtsConfig(env);
  if (!config || typeof fetchImpl !== 'function') return null;

  return {
    provider: 'volcengine-seed-tts',
    model: config.resourceId,
    baseUrl: config.baseUrl,
    defaultVoice: config.voice,
    voices: [...config.voices],

    async synthesize(input = {}) {
      const text = normalizeText(input.text);
      if (!text || text.length > MAX_VOLCENGINE_TTS_TEXT_LENGTH) {
        throw createProviderError(
          400,
          'Speech text must contain between 1 and 300 characters'
        );
      }
      const requestedVoice = normalizeText(input.voice);
      if (requestedVoice && !config.voices.includes(requestedVoice)) {
        throw createProviderError(400, 'Speech voice is not available');
      }

      let response;
      try {
        response = await fetchImpl(config.baseUrl, {
          method: 'POST',
          headers: {
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
            'X-Api-Key': config.apiKey,
            'X-Api-Request-Id': randomUUID(),
            'X-Api-Resource-Id': config.resourceId
          },
          body: JSON.stringify({
            user: { uid: 'cboard-api' },
            req_params: {
              text,
              speaker: requestedVoice || config.voice,
              audio_params: {
                format: 'mp3',
                sample_rate: 24000
              },
              speed_ratio: normalizeRate(input.rate)
            }
          }),
          signal: AbortSignal.timeout(config.timeoutMs)
        });
      } catch (error) {
        throw mapVolcengineTtsError(error);
      }

      if (!response || !response.ok) {
        throw createProviderError(
          response && response.status === 429 ? 429 : 502,
          response && response.status === 429
            ? 'Speech provider rate limit reached'
            : 'Speech provider request failed'
        );
      }

      let frames;
      try {
        frames = parseVolcengineTtsSse(await readBoundedResponseText(response));
      } catch (error) {
        throw mapVolcengineTtsError(error);
      }

      const chunks = [];
      let totalBytes = 0;
      let completed = false;
      for (const frame of frames) {
        const code = Number(frame.code);
        if (code === 20000000) {
          completed = true;
          continue;
        }
        if (code !== 0) {
          throw mapVolcengineTtsError(
            new Error(String(frame.message || `provider code ${code}`))
          );
        }
        if (!frame.data) continue;
        const data = decodeAudioChunk(frame.data);
        totalBytes += data.length;
        if (totalBytes > MAX_VOLCENGINE_TTS_AUDIO_BYTES) {
          throw createProviderError(
            502,
            'Speech provider returned invalid audio'
          );
        }
        chunks.push(data);
      }

      if (!completed || !chunks.length) {
        throw createProviderError(
          502,
          'Speech provider returned invalid audio'
        );
      }

      return {
        data: Buffer.concat(chunks, totalBytes),
        contentType: 'audio/mpeg',
        provider: this.provider,
        model: this.model
      };
    }
  };
}

module.exports = {
  DEFAULT_VOLCENGINE_TTS_BASE_URL,
  DEFAULT_VOLCENGINE_TTS_RESOURCE_ID,
  DEFAULT_VOLCENGINE_TTS_TIMEOUT_MS,
  DEFAULT_VOLCENGINE_TTS_VOICE,
  MAX_VOLCENGINE_TTS_AUDIO_BYTES,
  MAX_VOLCENGINE_TTS_RESPONSE_BYTES,
  createCommunicationVolcengineTtsProvider,
  mapVolcengineTtsError,
  parseVolcengineTtsSse,
  readBoundedResponseText,
  resolveVolcengineTtsConfig
};

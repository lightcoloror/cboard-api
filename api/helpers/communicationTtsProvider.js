'use strict';

const { OpenAI } = require('openai');
const {
  createCommunicationVolcengineTtsProvider
} = require('./communicationVolcengineTtsProvider');

const DEFAULT_TTS_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_TTS_VOICE = 'alloy';
const DEFAULT_TTS_TIMEOUT_MS = 25000;
const MIN_TTS_TIMEOUT_MS = 1000;
const MAX_TTS_TIMEOUT_MS = 60000;
const MAX_TTS_TEXT_LENGTH = 300;
const MAX_TTS_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_TTS_VOICES = 20;

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeBaseUrl(value) {
  const candidate = normalizeText(value) || DEFAULT_TTS_BASE_URL;
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
  if (!Number.isFinite(timeout)) return DEFAULT_TTS_TIMEOUT_MS;
  return Math.max(
    MIN_TTS_TIMEOUT_MS,
    Math.min(MAX_TTS_TIMEOUT_MS, Math.round(timeout))
  );
}

function normalizeRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return 1;
  return Math.max(0.5, Math.min(2, rate));
}

function normalizeVoice(value, fallback = DEFAULT_TTS_VOICE) {
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
    .slice(0, MAX_TTS_VOICES);
}

function createProviderError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function mapProviderError(error) {
  const status = Number(error && error.status);
  const code = String((error && error.code) || '');
  const name = String((error && error.name) || '');
  const message = String((error && error.message) || '');
  if (status === 429) {
    return createProviderError(429, 'Speech provider rate limit reached');
  }
  if (/timeout/i.test([code, name, message].join(' '))) {
    return createProviderError(504, 'Speech provider request timed out');
  }
  return createProviderError(502, 'Speech provider request failed');
}

function resolveCommunicationTtsConfig(env = process.env) {
  const apiKey =
    normalizeText(env.AI_TTS_API_KEY) || normalizeText(env.AI_API_KEY);
  if (!apiKey) return null;

  const baseUrl = normalizeBaseUrl(
    normalizeText(env.AI_TTS_BASE_URL) || normalizeText(env.AI_BASE_URL)
  );
  if (!baseUrl) return null;

  const voice = normalizeVoice(env.AI_TTS_VOICE);
  return {
    apiKey,
    baseUrl,
    model: normalizeText(env.AI_TTS_MODEL) || DEFAULT_TTS_MODEL,
    voice,
    voices: normalizeVoiceList(env.AI_TTS_VOICES, voice),
    timeoutMs: normalizeTimeout(env.AI_TTS_TIMEOUT_MS)
  };
}

function createCommunicationTtsClient(
  config,
  sdk = { OpenAI },
  fetchImpl = global.fetch
) {
  const options = {
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    timeout: config.timeoutMs,
    maxRetries: 1
  };
  if (typeof fetchImpl === 'function') {
    options.fetch = fetchImpl;
  }
  return new sdk.OpenAI(options);
}

function createCommunicationTtsProvider({
  env = process.env,
  sdk = { OpenAI },
  client,
  fetchImpl = global.fetch
} = {}) {
  const requestedProvider = normalizeText(env.AI_TTS_PROVIDER).toLowerCase();
  const useVolcengine =
    requestedProvider === 'volcengine' ||
    (!requestedProvider &&
      normalizeText(env.VOLCENGINE_TTS_API_KEY) &&
      !normalizeText(env.AI_TTS_API_KEY) &&
      !normalizeText(env.AI_API_KEY));
  if (useVolcengine) {
    return createCommunicationVolcengineTtsProvider({ env, fetchImpl });
  }
  if (requestedProvider && requestedProvider !== 'openai-compatible') {
    return null;
  }

  const config = resolveCommunicationTtsConfig(env);
  if (!config) return null;
  const speechClient =
    client || createCommunicationTtsClient(config, sdk, fetchImpl);

  return {
    provider: 'openai-compatible-speech',
    model: config.model,
    baseUrl: config.baseUrl,
    defaultVoice: config.voice,
    voices: [...config.voices],

    async synthesize(input = {}) {
      const text = normalizeText(input.text);
      if (!text || text.length > MAX_TTS_TEXT_LENGTH) {
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
        response = await speechClient.audio.speech.create({
          model: config.model,
          input: text,
          voice: requestedVoice || config.voice,
          response_format: 'mp3',
          speed: normalizeRate(input.rate)
        });
      } catch (error) {
        throw mapProviderError(error);
      }

      const contentType = String(
        response.headers && response.headers.get
          ? response.headers.get('content-type') || ''
          : ''
      )
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (contentType !== 'audio/mpeg') {
        throw createProviderError(
          502,
          'Speech provider returned invalid audio'
        );
      }

      let data;
      try {
        data = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        throw createProviderError(
          502,
          'Speech provider returned invalid audio'
        );
      }
      if (!data.length || data.length > MAX_TTS_AUDIO_BYTES) {
        throw createProviderError(
          502,
          'Speech provider returned invalid audio'
        );
      }

      return {
        data,
        contentType: 'audio/mpeg',
        provider: this.provider,
        model: this.model
      };
    }
  };
}

module.exports = {
  DEFAULT_TTS_BASE_URL,
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_TIMEOUT_MS,
  DEFAULT_TTS_VOICE,
  MAX_TTS_AUDIO_BYTES,
  MAX_TTS_TEXT_LENGTH,
  MAX_TTS_VOICES,
  createCommunicationTtsClient,
  createCommunicationTtsProvider,
  mapProviderError,
  normalizeRate,
  normalizeTimeout,
  normalizeVoiceList,
  resolveCommunicationTtsConfig
};

'use strict';

const { OpenAI, AzureOpenAI } = require('openai');

const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_AI_MODEL = 'gpt-4o-mini';
const DEFAULT_AI_TIMEOUT_MS = 15000;
const MIN_AI_TIMEOUT_MS = 1000;
const MAX_AI_TIMEOUT_MS = 60000;

// Adapt VKP's bounded provider options to the existing JS SDK. This is
// server configuration, never request-body input or a model-routing override.
function resolveResegmentRequestOptions(value) {
  if (value === undefined || value === '') return {};
  const invalid = () => Object.assign(
    new Error('Invalid server resegmentation request options'),
    { status: 503, code: 'AI_RESEGMENT_CONFIGURATION_INVALID' }
  );
  let raw;
  try { raw = JSON.parse(value); } catch (_) { throw invalid(); }
  const allowed = ['enable_thinking', 'thinking_budget', 'reasoning_effort',
    'thinking_mode', 'max_tokens', 'response_format'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(key => !allowed.includes(key))) throw invalid();
  const options = {};
  for (const key of ['max_tokens', 'thinking_budget']) {
    if (raw[key] !== undefined) {
      if (!Number.isInteger(raw[key]) || raw[key] < 128 || raw[key] > 8192)
        throw invalid();
      options[key] = raw[key];
    }
  }
  if (raw.enable_thinking !== undefined) {
    if (typeof raw.enable_thinking !== 'boolean') throw invalid();
    options.enable_thinking = raw.enable_thinking;
  }
  if (raw.thinking_mode !== undefined) {
    if (!['enabled', 'disabled'].includes(raw.thinking_mode) ||
        raw.enable_thinking !== undefined) throw invalid();
    options.thinking = { type: raw.thinking_mode };
  }
  if (raw.reasoning_effort !== undefined) {
    if (!['low', 'medium', 'high', 'max'].includes(raw.reasoning_effort))
      throw invalid();
    options.reasoning_effort = raw.reasoning_effort;
  }
  if ((raw.enable_thinking === false || raw.thinking_mode === 'disabled') &&
      (raw.thinking_budget !== undefined || raw.reasoning_effort !== undefined))
    throw invalid();
  if (raw.response_format !== undefined) {
    if (!['text', 'json_object', 'json_schema'].includes(raw.response_format))
      throw invalid();
    options.response_format = { type: raw.response_format };
    if (raw.response_format === 'json_schema') {
      // Same tokens schema used in the frozen VKP comparison; source/order
      // validation still happens independently in resegmentationContract.
      options.response_format.json_schema = {
        name: 'tuyujia_segmentation', strict: true,
        schema: { type: 'object', properties: {
          tokens: { type: 'array', items: { type: 'string' } }
        }, required: ['tokens'], additionalProperties: false }
      };
    }
  }
  return options;
}

// Sentence generation shares the existing bounded provider configuration,
// but its established wire contract is one sentence per line, not tokens JSON.
function resolveSentenceRequestOptions(value, resegmentValue) {
  const explicit = value !== undefined && value !== '';
  let options;
  try {
    options = resolveResegmentRequestOptions(explicit ? value : resegmentValue);
    if (explicit && options.response_format && options.response_format.type !== 'text') {
      throw new Error('Sentence output must use the existing text contract');
    }
  } catch (_) {
    throw Object.assign(new Error('Invalid server sentence request options'), {
      status: 503, code: 'AI_SENTENCE_CONFIGURATION_INVALID'
    });
  }
  if (options.response_format) options.response_format = { type: 'text' };
  return options;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeBaseUrl(value, fallback) {
  const candidate = normalizeText(value) || fallback;
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
  if (!Number.isFinite(timeout)) return DEFAULT_AI_TIMEOUT_MS;
  return Math.max(
    MIN_AI_TIMEOUT_MS,
    Math.min(MAX_AI_TIMEOUT_MS, Math.round(timeout))
  );
}

function resolveCommunicationAiConfig(env = process.env) {
  const compatibleKey = normalizeText(env.AI_API_KEY);
  if (compatibleKey) {
    const baseUrl = normalizeBaseUrl(
      env.AI_BASE_URL,
      DEFAULT_AI_BASE_URL
    );
    if (!baseUrl) return null;

    return {
      kind: 'openai-compatible',
      apiKey: compatibleKey,
      baseUrl,
      model: normalizeText(env.AI_MODEL) || DEFAULT_AI_MODEL,
      timeoutMs: normalizeTimeout(env.AI_REQUEST_TIMEOUT_MS)
    };
  }

  const azureKey = normalizeText(env.AZURE_OPENAI_API_KEY);
  if (!azureKey) return null;

  const baseUrl = normalizeBaseUrl(env.AZURE_OPENAI_ENDPOINT, '');
  if (!baseUrl) return null;

  return {
    kind: 'azure-openai',
    apiKey: azureKey,
    baseUrl,
    model:
      normalizeText(env.AZURE_OPENAI_DEPLOYMENT) || DEFAULT_AI_MODEL,
    apiVersion:
      normalizeText(env.AZURE_OPENAI_API_VERSION) || '2024-02-01',
    timeoutMs: normalizeTimeout(env.AI_REQUEST_TIMEOUT_MS)
  };
}

function createCommunicationAiProvider({
  env = process.env,
  sdk = { OpenAI, AzureOpenAI }
} = {}) {
  const config = resolveCommunicationAiConfig(env);
  if (!config) return null;

  const sharedOptions = {
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    maxRetries: 1
  };
  const client =
    config.kind === 'openai-compatible'
      ? new sdk.OpenAI({
          ...sharedOptions,
          baseURL: config.baseUrl
        })
      : new sdk.AzureOpenAI({
          ...sharedOptions,
          endpoint: config.baseUrl,
          apiVersion: config.apiVersion,
          deployment: config.model
        });

  return {
    client,
    provider: config.kind,
    model: config.model,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs
  };
}

module.exports = {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_TIMEOUT_MS,
  createCommunicationAiProvider,
  normalizeBaseUrl,
  normalizeTimeout,
  resolveResegmentRequestOptions,
  resolveSentenceRequestOptions,
  resolveCommunicationAiConfig
};

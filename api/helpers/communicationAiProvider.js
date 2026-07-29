'use strict';

const { OpenAI, AzureOpenAI } = require('openai');

const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_AI_MODEL = 'gpt-4o-mini';
const DEFAULT_AI_TIMEOUT_MS = 15000;
const MIN_AI_TIMEOUT_MS = 1000;
const MAX_AI_TIMEOUT_MS = 60000;

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
  resolveCommunicationAiConfig
};

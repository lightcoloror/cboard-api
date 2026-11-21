'use strict';

const path = require('path');
const {
  createConfirmedPictogramCache,
  createTwoTierPictogramPipeline
} = require('./pictogramRegenPipeline');
const { createPictogramVectorizer } = require('./pictogramVectorizer');
const {
  createCommunicationPictogramGenerationProvider
} = require('./communicationPictogramGenerationProvider');

const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'https://tuyujia.com.cn',
  'https://app.tuyujia.com.cn'
]);

function resolveCompositionConfig(env = process.env) {
  const enabledFlag = String(env.PICTOGRAM_COMPOSITION_V2_ENABLED || '').trim().toLowerCase();
  const enabled = enabledFlag === 'true' || enabledFlag === '1';

  const rawCacheDbPath = String(env.PICTOGRAM_COMPOSITION_CACHE_DB || '').trim();
  const cacheDbPath =
    rawCacheDbPath || path.resolve(__dirname, '../data/confirmedPictograms.sqlite');

  const enableVectorizer =
    String(env.PICTOGRAM_COMPOSITION_VECTORIZE || '').trim().toLowerCase() !== 'false';

  const vlmModel = String(env.COMMUNICATION_PICTOGRAM_VLM_MODEL || '').trim();

  const rawOrigins = String(env.PICTOGRAM_COMPOSITION_ALLOWED_ORIGINS || '').trim();
  const allowedOrigins = rawOrigins
    ? rawOrigins
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean)
    : Array.from(DEFAULT_ALLOWED_ORIGINS);

  return {
    enabled,
    cacheDbPath,
    enableVectorizer,
    vlmModel,
    allowedOrigins
  };
}

function createDefaultPictogramCompositionRuntime(options = {}) {
  const env = options.env || process.env;
  const config = resolveCompositionConfig(env);

  let cache = null;
  if (options.cache !== undefined) {
    cache = options.cache;
  } else {
    const dbPath =
      options.cacheDbPath !== undefined ? options.cacheDbPath : config.cacheDbPath;
    cache = createConfirmedPictogramCache({ dbPath });
  }

  const vectorizer =
    options.vectorizer !== undefined
      ? options.vectorizer
      : config.enableVectorizer
      ? createPictogramVectorizer(options.vectorizerOptions || {})
      : null;

  let imageEditClient = options.imageEditClient || null;
  if (!imageEditClient && options.autoWireImageProvider) {
    const provider = createCommunicationPictogramGenerationProvider({ env });
    if (provider && typeof provider.editFromReference === 'function') {
      imageEditClient = provider;
    }
  }

  const vlmClient = options.vlmClient || null;
  const vlmModel = options.vlmModel !== undefined ? options.vlmModel : config.vlmModel;

  const pipeline = createTwoTierPictogramPipeline({
    imageEditClient,
    vlmClient,
    vlmModel,
    cache,
    vectorizer
  });

  return {
    config,
    cache,
    vectorizer,
    pipeline,
    isTier2Configured: Boolean(imageEditClient),
    close() {
      if (cache && typeof cache.close === 'function') {
        cache.close();
      }
    }
  };
}

module.exports = {
  DEFAULT_ALLOWED_ORIGINS,
  createDefaultPictogramCompositionRuntime,
  resolveCompositionConfig
};

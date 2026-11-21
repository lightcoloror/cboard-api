'use strict';

const path = require('path');
const {
  createConfirmedPictogramCache,
  createTwoTierPictogramPipeline
} = require('./pictogramRegenPipeline');
const { createPictogramVectorizer } = require('./pictogramVectorizer');
const { createSymbolRecipePlanner } = require('./pictogramRecipePlanner');
const { createAutoBgeEmbedder } = require('./mulberryBgeEmbedder');
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

  const recipePlannerFlag = String(env.PICTOGRAM_COMPOSITION_RECIPE_PLANNER_ENABLED || '')
    .trim()
    .toLowerCase();
  const recipePlannerEnabled = recipePlannerFlag === 'true' || recipePlannerFlag === '1';
  const recipeModel =
    String(env.PICTOGRAM_COMPOSITION_RECIPE_MODEL || env.AI_MODEL || '').trim() || 'gpt-4o-mini';

  const bgeEmbedUrl = String(env.PICTOGRAM_BGE_EMBED_URL || '').trim();
  const bgeEmbedApiKey = String(env.PICTOGRAM_BGE_EMBED_API_KEY || '').trim();
  const bgeEmbedModel = String(env.PICTOGRAM_BGE_EMBED_MODEL || '').trim() || 'bge-small-zh-v1.5';
  const bgeModelPath = String(env.PICTOGRAM_BGE_MODEL_PATH || '').trim();
  const bgeDepsPath = String(env.PICTOGRAM_BGE_DEPS_PATH || '').trim();
  const bgePythonBin = String(env.PICTOGRAM_BGE_PYTHON_BIN || '').trim() || 'python';

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
    recipePlannerEnabled,
    recipeModel,
    bgeEmbedUrl,
    bgeEmbedApiKey,
    bgeEmbedModel,
    bgeModelPath,
    bgeDepsPath,
    bgePythonBin,
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

  let bgeEmbedder = options.bgeEmbedder !== undefined ? options.bgeEmbedder : null;
  if (bgeEmbedder === null && typeof options.embedQuery !== 'function' && options.bgeEmbedder !== null) {
    const resolvedEmbedUrl =
      options.bgeEmbedUrl !== undefined ? options.bgeEmbedUrl : config.bgeEmbedUrl;
    const resolvedModelPath =
      options.bgeModelPath !== undefined ? options.bgeModelPath : config.bgeModelPath;
    const resolvedDepsPath =
      options.bgeDepsPath !== undefined ? options.bgeDepsPath : config.bgeDepsPath;
    const resolvedPythonBin =
      options.bgePythonBin !== undefined ? options.bgePythonBin : config.bgePythonBin;

    if (resolvedEmbedUrl || resolvedModelPath) {
      bgeEmbedder = createAutoBgeEmbedder({
        embedUrl: resolvedEmbedUrl,
        embedApiKey: options.bgeEmbedApiKey !== undefined ? options.bgeEmbedApiKey : config.bgeEmbedApiKey,
        embedModel: options.bgeEmbedModel !== undefined ? options.bgeEmbedModel : config.bgeEmbedModel,
        modelPath: resolvedModelPath,
        depsPath: resolvedDepsPath,
        pythonBin: resolvedPythonBin,
        fetchImpl: options.bgeFetchImpl
      });
    }
  }

  const embedQuery =
    typeof options.embedQuery === 'function'
      ? options.embedQuery
      : bgeEmbedder && typeof bgeEmbedder.embed === 'function'
      ? text => bgeEmbedder.embed(text)
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

  let recipePlanner = options.recipePlanner || null;
  if (!recipePlanner && options.recipeLlmClient) {
    recipePlanner = createSymbolRecipePlanner({
      llmClient: options.recipeLlmClient,
      model: options.recipeModel || config.recipeModel,
      embedQuery
    });
  }

  const pipeline = createTwoTierPictogramPipeline({
    imageEditClient,
    vlmClient,
    vlmModel,
    cache,
    vectorizer,
    recipePlanner
  });

  return {
    config,
    cache,
    vectorizer,
    bgeEmbedder,
    embedQuery,
    recipePlanner,
    pipeline,
    isTier2Configured: Boolean(imageEditClient),
    isRecipePlannerConfigured: Boolean(recipePlanner),
    isBgeRuntimeReady: Boolean(embedQuery),
    close() {
      if (bgeEmbedder && typeof bgeEmbedder.close === 'function') {
        bgeEmbedder.close();
      }
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

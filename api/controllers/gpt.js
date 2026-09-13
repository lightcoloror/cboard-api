const { createCommunicationAi } = require('../helpers/communicationAi');
const {
  createCommunicationAiProvider
} = require('../helpers/communicationAiProvider');
const {
  createCommunicationPictogramGenerationProvider
} = require('../helpers/communicationPictogramGenerationProvider');
const {
  createCommunicationBackgroundRemovalProvider
} = require('../helpers/communicationBackgroundRemovalProvider');
const {
  createCommunicationDialectAsrProvider
} = require('../helpers/communicationDialectAsrProvider');
const {
  createCommunicationTtsProvider
} = require('../helpers/communicationTtsProvider');
const {
  resolveCommunicationEnhancementRateLimitConfig
} = require('../helpers/communicationEnhancementRateLimit');
const {
  createQuotaSnapshot,
  resolveCommunicationAiTokenQuotaConfig
} = require('../helpers/communicationAiTokenQuota');
const communicationAiUsage = require('../helpers/communicationAiUsage');

const AI_ENV_KEYS = [
  'AI_API_KEY',
  'AI_BASE_URL',
  'AI_MODEL',
  'AI_REQUEST_TIMEOUT_MS',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_DEPLOYMENT'
];
const BACKGROUND_REMOVAL_ENV_KEYS = [
  'BACKGROUND_REMOVAL_PROVIDER',
  'BACKGROUND_REMOVAL_API_URL',
  'BACKGROUND_REMOVAL_API_KEY',
  'BACKGROUND_REMOVAL_TIMEOUT_MS'
];
const PICTOGRAM_GENERATION_ENV_KEYS = [
  ...AI_ENV_KEYS,
  'AI_IMAGE_MODEL',
  'AI_IMAGE_REQUEST_TIMEOUT_MS',
  'AZURE_OPENAI_IMAGE_DEPLOYMENT'
];
const DIALECT_ASR_ENV_KEYS = [
  'COMMUNICATION_DIALECT_ASR_PROVIDER',
  'COMMUNICATION_DIALECT_ASR_TIMEOUT_SECONDS',
  'COMMUNICATION_TENCENTCLOUD_ASR_REGION',
  'COMMUNICATION_TENCENTCLOUD_ASR_SECRET_ID',
  'COMMUNICATION_TENCENTCLOUD_ASR_SECRET_KEY',
  'VOLCENGINE_ASR_API_KEY',
  'VOLCENGINE_ASR_APP_KEY',
  'VOLCENGINE_ASR_ACCESS_KEY',
  'VOLCENGINE_ASR_BASE_URL',
  'VOLCENGINE_ASR_RESOURCE_ID',
  'TENCENTCLOUD_SECRET_ID',
  'TENCENTCLOUD_SECRET_KEY'
];
const TTS_ENV_KEYS = [
  'AI_TTS_PROVIDER',
  'AI_TTS_API_KEY',
  'AI_TTS_BASE_URL',
  'AI_TTS_MODEL',
  'AI_TTS_VOICE',
  'AI_TTS_VOICES',
  'AI_TTS_TIMEOUT_MS',
  'AI_API_KEY',
  'AI_BASE_URL',
  'VOLCENGINE_TTS_API_KEY',
  'VOLCENGINE_TTS_BASE_URL',
  'VOLCENGINE_TTS_RESOURCE_ID',
  'VOLCENGINE_TTS_VOICE',
  'VOLCENGINE_TTS_VOICES',
  'VOLCENGINE_TTS_TIMEOUT_MS'
];

let cachedProvider = null;
let cachedProviderSignature = null;
let cachedPictogramGenerationProvider = null;
let cachedPictogramGenerationProviderSignature = null;
let cachedBackgroundRemovalProvider = null;
let cachedBackgroundRemovalProviderSignature = null;
let cachedDialectAsrProvider = null;
let cachedDialectAsrProviderSignature = null;
let cachedTtsProvider = null;
let cachedTtsProviderSignature = null;

function getCommunicationAiProvider() {
  const signature = AI_ENV_KEYS.map(key => process.env[key] || '').join('\n');
  if (signature !== cachedProviderSignature) {
    cachedProvider = createCommunicationAiProvider();
    cachedProviderSignature = signature;
  }
  return cachedProvider;
}

function createCommunicationAiUsageError() {
  const error = new Error('AI usage accounting is temporarily unavailable');
  error.status = 503;
  return error;
}

async function recordCommunicationAiUsage(req, provider, event) {
  try {
    await communicationAiUsage.settleAndRecordCommunicationAiUsage({
      req,
      provider,
      event
    });
  } catch (error) {
    throw createCommunicationAiUsageError();
  }
}

function getCommunicationAi(req) {
  const provider = getCommunicationAiProvider();
  return provider
    ? createCommunicationAi({
        client: provider.client,
        model: provider.model,
        onUsage: event => recordCommunicationAiUsage(req, provider, event)
      })
    : null;
}

function getCommunicationPictogramGenerationProvider() {
  const signature = PICTOGRAM_GENERATION_ENV_KEYS.map(
    key => process.env[key] || ''
  ).join('\n');
  if (signature !== cachedPictogramGenerationProviderSignature) {
    cachedPictogramGenerationProvider = createCommunicationPictogramGenerationProvider();
    cachedPictogramGenerationProviderSignature = signature;
  }
  return cachedPictogramGenerationProvider;
}

function getCommunicationBackgroundRemovalProvider() {
  const signature = BACKGROUND_REMOVAL_ENV_KEYS.map(
    key => process.env[key] || ''
  ).join('\n');
  if (signature !== cachedBackgroundRemovalProviderSignature) {
    cachedBackgroundRemovalProvider = createCommunicationBackgroundRemovalProvider();
    cachedBackgroundRemovalProviderSignature = signature;
  }
  return cachedBackgroundRemovalProvider;
}

function getCommunicationDialectAsrProvider() {
  const signature = DIALECT_ASR_ENV_KEYS.map(
    key => process.env[key] || ''
  ).join('\n');
  if (signature !== cachedDialectAsrProviderSignature) {
    cachedDialectAsrProvider = createCommunicationDialectAsrProvider();
    cachedDialectAsrProviderSignature = signature;
  }
  return cachedDialectAsrProvider;
}

function getCommunicationTtsProvider() {
  const signature = TTS_ENV_KEYS.map(key => process.env[key] || '').join('\n');
  if (signature !== cachedTtsProviderSignature) {
    cachedTtsProvider = createCommunicationTtsProvider();
    cachedTtsProviderSignature = signature;
  }
  return cachedTtsProvider;
}

module.exports = {
  editPhrase,
  getCommunicationAiHealth,
  getCommunicationAiUsage,
  generateCommunicationPictogram,
  generateCommunicationSentences,
  normalizeCommunicationDialectText,
  removeCommunicationImageBackground,
  recognizeCommunicationDialectAudio,
  recognizeCommunicationImageText,
  resegmentCommunicationText,
  synthesizeCommunicationSpeech,
  suggestCommunicationPictogramMetadata
};

function getCommunicationAiHealth(req, res) {
  const provider = getCommunicationAiProvider();
  const pictogramGenerationProvider = getCommunicationPictogramGenerationProvider();
  const backgroundRemovalProvider = getCommunicationBackgroundRemovalProvider();
  const dialectAsrProvider = getCommunicationDialectAsrProvider();
  const speechProvider = getCommunicationTtsProvider();
  const rateLimit = resolveCommunicationEnhancementRateLimitConfig();
  const tokenQuota = resolveCommunicationAiTokenQuotaConfig();
  return res.status(200).json({
    configured: Boolean(provider),
    provider: provider ? provider.provider : 'none',
    model: provider ? provider.model : '',
    baseUrl: provider ? provider.baseUrl : '',
    imageAiConfigured: Boolean(pictogramGenerationProvider),
    imageAiProvider: pictogramGenerationProvider
      ? pictogramGenerationProvider.provider
      : 'none',
    imageAiModel: pictogramGenerationProvider
      ? pictogramGenerationProvider.model
      : '',
    dialectAsrConfigured: Boolean(dialectAsrProvider),
    dialectAsrProvider: dialectAsrProvider
      ? dialectAsrProvider.provider
      : 'none',
    dialectAsrEngine: dialectAsrProvider ? dialectAsrProvider.engine : '',
    backgroundRemovalConfigured: Boolean(backgroundRemovalProvider),
    backgroundRemovalProvider: backgroundRemovalProvider
      ? backgroundRemovalProvider.provider
      : 'none',
    speechConfigured: Boolean(speechProvider),
    speechProvider: speechProvider ? speechProvider.provider : 'none',
    speechModel: speechProvider ? speechProvider.model : '',
    speechVoice: speechProvider ? speechProvider.defaultVoice : '',
    speechVoices: speechProvider ? speechProvider.voices : [],
    enhancementRateLimitEnabled: rateLimit.enabled,
    enhancementPointsPerMinute: rateLimit.pointsPerMinute,
    enhancementMonthlyPoints: rateLimit.monthlyPoints,
    aiTokenQuotaEnabled: tokenQuota.enabled,
    aiMonthlyTokenQuota: tokenQuota.monthlyTokens,
    aiTextTokenReservation: tokenQuota.textReservationTokens,
    aiImageTokenReservation: tokenQuota.imageReservationTokens
  });
}

async function getCommunicationAiUsage(req, res) {
  if (process.env.CARE_NEXT_ENABLED === 'true') return res.status(409).json({ code: 'USE_FUNDING_USAGE', message: 'Select a profile and query its explicit funding account.' });
  if (!req || !req.user || !req.user.id) {
    return res.status(401).json({
      error: { message: 'Authentication is required' }
    });
  }

  try {
    const usage = await communicationAiUsage.getMonthlyUsage({
      userId: req.user.id
    });
    const quotaService = req.communicationAiTokenQuotaService;
    const tokenQuota = quotaService
      ? await quotaService.getStatus({ userId: req.user.id })
      : createQuotaSnapshot(
          resolveCommunicationAiTokenQuotaConfig({}, 'test'),
          new Date()
        );
    return res.status(200).json({ ...usage, tokenQuota });
  } catch (error) {
    return sendCommunicationAiError(res, createCommunicationAiUsageError());
  }
}

function sendCommunicationAiError(res, error) {
  const status = error && Number.isInteger(error.status) ? error.status : 502;
  return res.status(status).json({
    error: {
      message: (error && error.message) || 'Communication AI request failed'
    }
  });
}

function setCommunicationPrivateResponseHeaders(res) {
  res.set('Cache-Control', 'no-store, private');
  res.set('X-Content-Type-Options', 'nosniff');
}

async function generateCommunicationSentences(req, res) {
  const communicationAi = getCommunicationAi(req);
  if (!communicationAi) {
    return sendCommunicationAiError(res, {
      status: 503,
      message: 'Communication AI is not configured'
    });
  }

  try {
    if (req.careUsage) req.careUsage.markProviderStarted();
    return res
      .status(200)
      .json(await communicationAi.generateSentenceCandidates(process.env.CARE_NEXT_ENABLED === 'true'
        ? { ...req.body, context: { scene: req.body && req.body.context && req.body.context.scene } } : req.body));
  } catch (error) {
    return sendCommunicationAiError(res, error);
  }
}

async function generateCommunicationPictogram(req, res) {
  const provider = getCommunicationPictogramGenerationProvider();
  if (!provider) {
    return sendCommunicationAiError(res, {
      status: 503,
      message: 'Pictogram generation is not configured'
    });
  }

  try {
    if (req.careUsage) req.careUsage.markProviderStarted();
    const result = await provider.generate(req.body, {
      userId: req && req.user && req.user.id
    });
    const { usage, ...payload } = result;
    await recordCommunicationAiUsage(req, provider, {
      operation: 'pictogram-generation',
      model: provider.model,
      usage
    });
    setCommunicationPrivateResponseHeaders(res);
    return res.status(200).json(payload);
  } catch (error) {
    return sendCommunicationAiError(res, error);
  }
}

async function resegmentCommunicationText(req, res) {
  const communicationAi = getCommunicationAi(req);
  if (!communicationAi) {
    return sendCommunicationAiError(res, {
      status: 503,
      message: 'Communication AI is not configured'
    });
  }

  try {
    if (req.careUsage) req.careUsage.markProviderStarted();
    return res.status(200).json(await communicationAi.resegmentText(req.body));
  } catch (error) {
    return sendCommunicationAiError(res, error);
  }
}

async function normalizeCommunicationDialectText(req, res) {
  const communicationAi = getCommunicationAi(req);
  if (!communicationAi) {
    return sendCommunicationAiError(res, {
      status: 503,
      message: 'Communication AI is not configured'
    });
  }

  try {
    if (req.careUsage) req.careUsage.markProviderStarted();
    return res
      .status(200)
      .json(await communicationAi.normalizeDialectText(req.body));
  } catch (error) {
    return sendCommunicationAiError(res, error);
  }
}

async function recognizeCommunicationDialectAudio(req, res) {
  const provider = getCommunicationDialectAsrProvider();
  if (!provider) {
    return sendCommunicationAiError(res, {
      status: 503,
      message: 'Dialect ASR is not configured'
    });
  }

  try {
    const audio = req && req.files && req.files.audio && req.files.audio[0];
    if (req.careUsage) req.careUsage.markProviderStarted();
    const result = await provider.recognize(audio);
    setCommunicationPrivateResponseHeaders(res);
    return res.status(200).json(result);
  } catch (error) {
    return sendCommunicationAiError(res, error);
  }
}

async function recognizeCommunicationImageText(req, res) {
  const communicationAi = getCommunicationAi(req);
  if (!communicationAi) {
    return sendCommunicationAiError(res, {
      status: 503,
      message: 'Communication AI is not configured'
    });
  }

  try {
    const image = req && req.files && req.files.image && req.files.image[0];
    if (req.careUsage) req.careUsage.markProviderStarted();
    const result = await communicationAi.recognizeImageText(image);
    setCommunicationPrivateResponseHeaders(res);
    return res.status(200).json(result);
  } catch (error) {
    return sendCommunicationAiError(res, error);
  }
}

async function suggestCommunicationPictogramMetadata(req, res) {
  const communicationAi = getCommunicationAi(req);
  if (!communicationAi) {
    return sendCommunicationAiError(res, {
      status: 503,
      message: 'Communication AI is not configured'
    });
  }

  try {
    const image = req && req.files && req.files.image && req.files.image[0];
    if (req.careUsage) req.careUsage.markProviderStarted();
    const result = await communicationAi.suggestPictogramMetadata(image);
    setCommunicationPrivateResponseHeaders(res);
    return res.status(200).json(result);
  } catch (error) {
    return sendCommunicationAiError(res, error);
  }
}

async function removeCommunicationImageBackground(req, res) {
  const provider = getCommunicationBackgroundRemovalProvider();
  if (!provider) {
    return sendCommunicationAiError(res, {
      status: 503,
      message: 'Background removal is not configured'
    });
  }

  try {
    const image = req && req.files && req.files.image && req.files.image[0];
    if (req.careUsage) req.careUsage.markProviderStarted();
    const result = await provider.removeBackground(image);
    setCommunicationPrivateResponseHeaders(res);
    return res.status(200).json(result);
  } catch (error) {
    return sendCommunicationAiError(res, error);
  }
}

async function synthesizeCommunicationSpeech(req, res) {
  const provider = getCommunicationTtsProvider();
  if (!provider) {
    return sendCommunicationAiError(res, {
      status: 503,
      message: 'Communication speech is not configured'
    });
  }

  try {
    if (req.careUsage) req.careUsage.markProviderStarted();
    const result = await provider.synthesize(req.body);
    res.set('Content-Type', result.contentType);
    setCommunicationPrivateResponseHeaders(res);
    return res.status(200).send(result.data);
  } catch (error) {
    return sendCommunicationAiError(res, error);
  }
}

async function editPhrase(req, res) {
  const phraseToEdit = req.body.phrase;
  const phraseLanguage = req.body.language;
  if (!phraseToEdit) {
    return res.status(400).json();
  }

  const provider = getCommunicationAiProvider();
  if (!provider) {
    return res.status(503).json({
      error: { message: 'Communication AI is not configured' }
    });
  }

  try {
    if (req.careUsage) req.careUsage.markProviderStarted();
    const response = await provider.client.chat.completions.create({
      model: provider.model,
      messages: [
        {
          role: 'user',
          content: `grammatically improve this phrase: '${phraseToEdit}'. The result should be in '${phraseLanguage}'. Don't add additional information to the phrase.`
        }
      ],
      max_tokens: 50,
      temperature: 0
    });

    await recordCommunicationAiUsage(req, provider, {
      operation: 'edit-phrase',
      model: response.model || provider.model,
      usage: response.usage || null
    });

    const editedPhrase = response.choices[0]?.message?.content;
    if (editedPhrase) return res.status(200).json({ phrase: editedPhrase });
    return sendCommunicationAiError(res, {
      status: 502,
      message: 'AI returned no edited phrase'
    });
  } catch (error) {
    return sendCommunicationAiError(res, error);
  }
}

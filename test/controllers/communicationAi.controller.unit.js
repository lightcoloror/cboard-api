'use strict';

const chai = require('chai');
const gptController = require('../../api/controllers/gpt');
const communicationAiUsage = require('../../api/helpers/communicationAiUsage');

const expect = chai.expect;
const AI_ENV_KEYS = [
  'AI_API_KEY',
  'AI_BASE_URL',
  'AI_MODEL',
  'AI_REQUEST_TIMEOUT_MS',
  'AI_IMAGE_MODEL',
  'AI_IMAGE_REQUEST_TIMEOUT_MS',
  'AI_TTS_PROVIDER',
  'AI_TTS_API_KEY',
  'AI_TTS_BASE_URL',
  'AI_TTS_MODEL',
  'AI_TTS_VOICE',
  'AI_TTS_VOICES',
  'AI_TTS_TIMEOUT_MS',
  'VOLCENGINE_TTS_API_KEY',
  'VOLCENGINE_TTS_BASE_URL',
  'VOLCENGINE_TTS_RESOURCE_ID',
  'VOLCENGINE_TTS_VOICE',
  'VOLCENGINE_TTS_VOICES',
  'VOLCENGINE_TTS_TIMEOUT_MS',
  'BACKGROUND_REMOVAL_PROVIDER',
  'BACKGROUND_REMOVAL_API_URL',
  'BACKGROUND_REMOVAL_API_KEY',
  'BACKGROUND_REMOVAL_TIMEOUT_MS',
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
  'COMMUNICATION_ENHANCEMENT_RATE_LIMIT_ENABLED',
  'COMMUNICATION_ENHANCEMENT_POINTS_PER_MINUTE',
  'COMMUNICATION_ENHANCEMENT_MONTHLY_POINTS',
  'COMMUNICATION_AI_TOKEN_QUOTA_ENABLED',
  'COMMUNICATION_AI_MONTHLY_TOKEN_QUOTA',
  'COMMUNICATION_AI_TEXT_TOKEN_RESERVATION',
  'COMMUNICATION_AI_IMAGE_TOKEN_RESERVATION',
  'TENCENTCLOUD_SECRET_ID',
  'TENCENTCLOUD_SECRET_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_DEPLOYMENT',
  'AZURE_OPENAI_IMAGE_DEPLOYMENT'
];

function createResponseHarness() {
  const value = {
    statusCode: 0,
    body: null,
    headers: {}
  };
  return {
    value,
    response: {
      status(statusCode) {
        value.statusCode = statusCode;
        return this;
      },
      json(body) {
        value.body = body;
        return body;
      },
      set(name, content) {
        value.headers[name] = content;
        return this;
      },
      send(body) {
        value.body = body;
        return body;
      }
    }
  };
}

describe('Communication AI controller configuration', function() {
  const originalEnv = {};
  const originalFetch = global.fetch;
  const originalGetMonthlyUsage = communicationAiUsage.getMonthlyUsage;

  before(function() {
    AI_ENV_KEYS.forEach(key => {
      originalEnv[key] = process.env[key];
    });
  });

  beforeEach(function() {
    AI_ENV_KEYS.forEach(key => {
      delete process.env[key];
    });
  });

  after(function() {
    AI_ENV_KEYS.forEach(key => {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });
    global.fetch = originalFetch;
    communicationAiUsage.getMonthlyUsage = originalGetMonthlyUsage;
  });

  afterEach(function() {
    communicationAiUsage.getMonthlyUsage = originalGetMonthlyUsage;
  });

  it('returns only the authenticated user current-month usage summary', async function() {
    let query;
    communicationAiUsage.getMonthlyUsage = async input => {
      query = input;
      return {
        month: '2026-07',
        requestCount: 2,
        reportedRequestCount: 2,
        unreportedRequestCount: 0,
        promptTokens: 30,
        completionTokens: 8,
        totalTokens: 38,
        providerReported: true,
        breakdown: []
      };
    };
    const harness = createResponseHarness();

    await gptController.getCommunicationAiUsage(
      {
        user: { id: 'user-id' },
        communicationAiTokenQuotaService: {
          getStatus: async input => ({
            enabled: true,
            month: '2026-07',
            limitTokens: 1000000,
            consumedTokens: 38,
            remainingTokens: 999962,
            resetAt: '2026-08-01T00:00:00.000Z',
            queriedUser: input.userId
          })
        }
      },
      harness.response
    );

    expect(query).to.deep.equal({ userId: 'user-id' });
    expect(harness.value.statusCode).to.equal(200);
    expect(harness.value.body.totalTokens).to.equal(38);
    expect(harness.value.body.tokenQuota).to.deep.equal({
      enabled: true,
      month: '2026-07',
      limitTokens: 1000000,
      consumedTokens: 38,
      remainingTokens: 999962,
      resetAt: '2026-08-01T00:00:00.000Z',
      queriedUser: 'user-id'
    });
    expect(harness.value.body).not.to.have.any.keys('prompt', 'text');
  });

  it('returns a bounded error when usage storage is unavailable', async function() {
    communicationAiUsage.getMonthlyUsage = async () => {
      throw new Error('mongodb://secret-host/private');
    };
    const harness = createResponseHarness();

    await gptController.getCommunicationAiUsage(
      { user: { id: 'user-id' } },
      harness.response
    );

    expect(harness.value.statusCode).to.equal(503);
    expect(harness.value.body).to.deep.equal({
      error: {
        message: 'AI usage accounting is temporarily unavailable'
      }
    });
  });

  it('reports an OpenAI-compatible provider without returning its key', function() {
    process.env.AI_API_KEY = 'server-only-secret';
    process.env.AI_BASE_URL = 'https://compatible.example/v1/';
    process.env.AI_MODEL = 'compatible-model';
    process.env.AI_IMAGE_MODEL = 'gpt-image-1';
    process.env.COMMUNICATION_ENHANCEMENT_RATE_LIMIT_ENABLED = 'true';
    process.env.COMMUNICATION_ENHANCEMENT_POINTS_PER_MINUTE = '45';
    process.env.COMMUNICATION_ENHANCEMENT_MONTHLY_POINTS = '2500';
    const harness = createResponseHarness();

    gptController.getCommunicationAiHealth(null, harness.response);

    expect(harness.value.statusCode).to.equal(200);
    expect(harness.value.body).to.deep.equal({
      configured: true,
      provider: 'openai-compatible',
      model: 'compatible-model',
      baseUrl: 'https://compatible.example/v1',
      imageAiConfigured: true,
      imageAiProvider: 'openai-compatible',
      imageAiModel: 'gpt-image-1',
      dialectAsrConfigured: false,
      dialectAsrProvider: 'none',
      dialectAsrEngine: '',
      backgroundRemovalConfigured: false,
      backgroundRemovalProvider: 'none',
      speechConfigured: true,
      speechProvider: 'openai-compatible-speech',
      speechModel: 'gpt-4o-mini-tts',
      speechVoice: 'alloy',
      speechVoices: ['alloy'],
      enhancementRateLimitEnabled: true,
      enhancementPointsPerMinute: 45,
      enhancementMonthlyPoints: 2500,
      aiTokenQuotaEnabled: false,
      aiMonthlyTokenQuota: 1000000,
      aiTextTokenReservation: 4096,
      aiImageTokenReservation: 32768
    });
    expect(harness.value.body).not.to.have.property('apiKey');
  });

  it('reports a safe unconfigured state when no provider key exists', function() {
    const harness = createResponseHarness();

    gptController.getCommunicationAiHealth(null, harness.response);

    expect(harness.value.body).to.deep.equal({
      configured: false,
      provider: 'none',
      model: '',
      baseUrl: '',
      imageAiConfigured: false,
      imageAiProvider: 'none',
      imageAiModel: '',
      dialectAsrConfigured: false,
      dialectAsrProvider: 'none',
      dialectAsrEngine: '',
      backgroundRemovalConfigured: false,
      backgroundRemovalProvider: 'none',
      speechConfigured: false,
      speechProvider: 'none',
      speechModel: '',
      speechVoice: '',
      speechVoices: [],
      enhancementRateLimitEnabled: false,
      enhancementPointsPerMinute: 30,
      enhancementMonthlyPoints: 1000,
      aiTokenQuotaEnabled: false,
      aiMonthlyTokenQuota: 1000000,
      aiTextTokenReservation: 4096,
      aiImageTokenReservation: 32768
    });
  });

  it('reports a configured Volcengine speech provider without exposing its key', function() {
    process.env.AI_TTS_PROVIDER = 'volcengine';
    process.env.VOLCENGINE_TTS_API_KEY = 'server-only-volcengine-key';
    process.env.VOLCENGINE_TTS_RESOURCE_ID = 'seed-tts-2.0';
    process.env.VOLCENGINE_TTS_VOICE = 'zh_female_vv_uranus_bigtts';
    process.env.VOLCENGINE_TTS_VOICES =
      'zh_female_vv_uranus_bigtts,zh_male_dayi_saturn_bigtts';
    const harness = createResponseHarness();

    gptController.getCommunicationAiHealth(null, harness.response);

    expect(harness.value.body).to.include({
      speechConfigured: true,
      speechProvider: 'volcengine-seed-tts',
      speechModel: 'seed-tts-2.0',
      speechVoice: 'zh_female_vv_uranus_bigtts'
    });
    expect(harness.value.body.speechVoices).to.deep.equal([
      'zh_female_vv_uranus_bigtts',
      'zh_male_dayi_saturn_bigtts'
    ]);
    expect(JSON.stringify(harness.value.body)).not.to.include(
      'server-only-volcengine-key'
    );
  });

  it('reports dedicated enhancement providers without exposing secrets or endpoints', function() {
    process.env.BACKGROUND_REMOVAL_PROVIDER = 'rembg';
    process.env.BACKGROUND_REMOVAL_API_URL = 'http://127.0.0.1:7000/api/remove';
    process.env.COMMUNICATION_DIALECT_ASR_PROVIDER = 'tencentcloud';
    process.env.COMMUNICATION_TENCENTCLOUD_ASR_SECRET_ID = 'server-only-id';
    process.env.COMMUNICATION_TENCENTCLOUD_ASR_SECRET_KEY = 'server-only-key';
    const harness = createResponseHarness();

    gptController.getCommunicationAiHealth(null, harness.response);

    expect(harness.value.body).to.include({
      dialectAsrConfigured: true,
      dialectAsrProvider: 'tencentcloud-asr',
      dialectAsrEngine: '16k_yue',
      backgroundRemovalConfigured: true,
      backgroundRemovalProvider: 'rembg'
    });
    expect(harness.value.body).not.to.have.any.keys(
      'secretId',
      'secretKey',
      'apiKey',
      'backgroundRemovalEndpoint'
    );
  });

  it('reports Volcengine bigmodel ASR without exposing its server key', function() {
    process.env.COMMUNICATION_DIALECT_ASR_PROVIDER = 'volcengine';
    process.env.VOLCENGINE_ASR_API_KEY = 'server-only-volcengine-asr-key';
    const harness = createResponseHarness();

    gptController.getCommunicationAiHealth(null, harness.response);

    expect(harness.value.body).to.include({
      dialectAsrConfigured: true,
      dialectAsrProvider: 'volcengine-bigasr',
      dialectAsrEngine: 'bigmodel'
    });
    expect(JSON.stringify(harness.value.body)).not.to.include(
      'server-only-volcengine-asr-key'
    );
  });

  it('refreshes speech configuration when only the voice allowlist changes', function() {
    process.env.AI_TTS_API_KEY = 'server-only-speech-secret';
    process.env.AI_TTS_VOICE = 'alloy';
    process.env.AI_TTS_VOICES = 'alloy';
    const firstHarness = createResponseHarness();

    gptController.getCommunicationAiHealth(null, firstHarness.response);

    expect(firstHarness.value.body.speechVoices).to.deep.equal(['alloy']);

    process.env.AI_TTS_VOICES = 'alloy,verse';
    const secondHarness = createResponseHarness();

    gptController.getCommunicationAiHealth(null, secondHarness.response);

    expect(secondHarness.value.body.speechVoices).to.deep.equal([
      'alloy',
      'verse'
    ]);
  });

  it('does not accept an OCR upload when the server provider is unconfigured', async function() {
    const harness = createResponseHarness();

    await gptController.recognizeCommunicationImageText(
      {
        files: {
          image: [
            {
              buffer: Buffer.from('image'),
              mimetype: 'image/png'
            }
          ]
        }
      },
      harness.response
    );

    expect(harness.value.statusCode).to.equal(503);
    expect(harness.value.body.error.message).to.equal(
      'Communication AI is not configured'
    );
  });

  it('does not normalize dialect text when the server provider is unconfigured', async function() {
    const harness = createResponseHarness();

    await gptController.normalizeCommunicationDialectText(
      {
        body: {
          text: '我想饮水',
          dialect: 'cantonese'
        }
      },
      harness.response
    );

    expect(harness.value.statusCode).to.equal(503);
    expect(harness.value.body.error.message).to.equal(
      'Communication AI is not configured'
    );
  });

  it('does not accept dialect audio when its provider is unconfigured', async function() {
    const harness = createResponseHarness();

    await gptController.recognizeCommunicationDialectAudio(
      {
        files: {
          audio: [
            {
              buffer: Buffer.concat([Buffer.from('ID3'), Buffer.from('audio')]),
              mimetype: 'audio/mpeg'
            }
          ]
        }
      },
      harness.response
    );

    expect(harness.value.statusCode).to.equal(503);
    expect(harness.value.body.error.message).to.equal(
      'Dialect ASR is not configured'
    );
  });

  it('does not accept a metadata image when the server provider is unconfigured', async function() {
    const harness = createResponseHarness();

    await gptController.suggestCommunicationPictogramMetadata(
      {
        files: {
          image: [
            {
              buffer: Buffer.from('image'),
              mimetype: 'image/jpeg'
            }
          ]
        }
      },
      harness.response
    );

    expect(harness.value.statusCode).to.equal(503);
    expect(harness.value.body.error.message).to.equal(
      'Communication AI is not configured'
    );
  });

  it('does not generate a pictogram when its provider is unconfigured', async function() {
    const harness = createResponseHarness();

    await gptController.generateCommunicationPictogram(
      { body: { label: '水' }, user: { id: 'user-1' } },
      harness.response
    );

    expect(harness.value.statusCode).to.equal(503);
    expect(harness.value.body.error.message).to.equal(
      'Pictogram generation is not configured'
    );
  });

  it('does not accept a background removal image when its provider is unconfigured', async function() {
    const harness = createResponseHarness();

    await gptController.removeCommunicationImageBackground(
      {
        files: {
          image: [
            {
              buffer: Buffer.from('image'),
              mimetype: 'image/png'
            }
          ]
        }
      },
      harness.response
    );

    expect(harness.value.statusCode).to.equal(503);
    expect(harness.value.body.error.message).to.equal(
      'Background removal is not configured'
    );
  });

  it('does not synthesize speech when no server key exists', async function() {
    const harness = createResponseHarness();

    await gptController.synthesizeCommunicationSpeech(
      { body: { text: '我想喝水。' } },
      harness.response
    );

    expect(harness.value.statusCode).to.equal(503);
    expect(harness.value.body.error.message).to.equal(
      'Communication speech is not configured'
    );
  });

  it('returns bounded private audio without exposing provider credentials', async function() {
    process.env.AI_TTS_API_KEY = 'server-only-speech-secret';
    process.env.AI_TTS_BASE_URL = 'https://speech.example/v1';
    process.env.AI_TTS_MODEL = 'speech-model';
    global.fetch = async function() {
      return new Response(Buffer.from('mp3-audio'), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' }
      });
    };
    const harness = createResponseHarness();

    await gptController.synthesizeCommunicationSpeech(
      { body: { text: '需要帮助。', rate: 1.2 } },
      harness.response
    );

    expect(harness.value.statusCode).to.equal(200);
    expect(harness.value.headers).to.deep.equal({
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff'
    });
    expect(harness.value.body.equals(Buffer.from('mp3-audio'))).to.equal(true);
    expect(String(harness.value.body)).not.to.include('server-only');
  });

  it('returns bounded MP3 audio through the Volcengine provider path', async function() {
    process.env.AI_TTS_PROVIDER = 'volcengine';
    process.env.VOLCENGINE_TTS_API_KEY = 'server-only-volcengine-key';
    process.env.VOLCENGINE_TTS_VOICE = 'zh_female_vv_uranus_bigtts';
    global.fetch = async function() {
      return new Response(
        [
          `data: ${JSON.stringify({
            code: 0,
            data: Buffer.from('doubao-mp3').toString('base64')
          })}`,
          `data: ${JSON.stringify({ code: 20000000 })}`,
          ''
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        }
      );
    };
    const harness = createResponseHarness();

    await gptController.synthesizeCommunicationSpeech(
      { body: { text: '需要帮助。', rate: 1.1 } },
      harness.response
    );

    expect(harness.value.statusCode).to.equal(200);
    expect(harness.value.headers['Content-Type']).to.equal('audio/mpeg');
    expect(harness.value.body.equals(Buffer.from('doubao-mp3'))).to.equal(true);
    expect(String(harness.value.body)).not.to.include('server-only');
  });

  it('rejects a speech voice outside the configured public list', async function() {
    process.env.AI_TTS_API_KEY = 'server-only-speech-secret';
    process.env.AI_TTS_VOICE = 'alloy';
    process.env.AI_TTS_VOICES = 'alloy,verse';
    const harness = createResponseHarness();

    await gptController.synthesizeCommunicationSpeech(
      { body: { text: '需要帮助。', voice: 'private-provider-voice' } },
      harness.response
    );

    expect(harness.value.statusCode).to.equal(400);
    expect(harness.value.body.error.message).to.equal(
      'Speech voice is not available'
    );
  });
});

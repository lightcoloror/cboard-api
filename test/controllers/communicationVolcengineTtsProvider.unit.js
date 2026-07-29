'use strict';

const chai = require('chai');
const {
  DEFAULT_VOLCENGINE_TTS_BASE_URL,
  MAX_VOLCENGINE_TTS_RESPONSE_BYTES,
  createCommunicationVolcengineTtsProvider,
  parseVolcengineTtsSse,
  resolveVolcengineTtsConfig
} = require('../../api/helpers/communicationVolcengineTtsProvider');

const expect = chai.expect;

function sseResponse(frames, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return frames
        .map(frame => `event: message\ndata: ${JSON.stringify(frame)}\n`)
        .join('\n');
    }
  };
}

function createEnvironment() {
  return {
    VOLCENGINE_TTS_API_KEY: 'server-only-key',
    VOLCENGINE_TTS_RESOURCE_ID: 'seed-tts-2.0',
    VOLCENGINE_TTS_VOICE: 'zh_female_vv_uranus_bigtts',
    VOLCENGINE_TTS_VOICES:
      'zh_female_vv_uranus_bigtts,zh_male_dayi_saturn_bigtts',
    VOLCENGINE_TTS_TIMEOUT_MS: '3500'
  };
}

describe('Communication Volcengine TTS provider', function() {
  it('stays disabled until a server-only API key is configured', function() {
    expect(resolveVolcengineTtsConfig({})).to.equal(null);
    expect(createCommunicationVolcengineTtsProvider({ env: {} })).to.equal(
      null
    );
  });

  it('resolves a bounded V3 configuration and public voice allowlist', function() {
    expect(resolveVolcengineTtsConfig(createEnvironment())).to.deep.equal({
      apiKey: 'server-only-key',
      baseUrl: DEFAULT_VOLCENGINE_TTS_BASE_URL,
      resourceId: 'seed-tts-2.0',
      voice: 'zh_female_vv_uranus_bigtts',
      voices: [
        'zh_female_vv_uranus_bigtts',
        'zh_male_dayi_saturn_bigtts'
      ],
      timeoutMs: 3500
    });
  });

  it('posts the OpenClaw-compatible V3 request and joins MP3 SSE frames', async function() {
    let requestUrl;
    let requestOptions;
    const provider = createCommunicationVolcengineTtsProvider({
      env: createEnvironment(),
      fetchImpl: async (url, options) => {
        requestUrl = url;
        requestOptions = options;
        return sseResponse([
          { code: 0, data: Buffer.from('mp3-').toString('base64') },
          { code: 0, data: Buffer.from('audio').toString('base64') },
          { code: 20000000 }
        ]);
      }
    });

    const result = await provider.synthesize({
      text: '我想喝水。',
      voice: 'zh_male_dayi_saturn_bigtts',
      rate: 9
    });

    expect(requestUrl).to.equal(DEFAULT_VOLCENGINE_TTS_BASE_URL);
    expect(requestOptions.headers).to.include({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'X-Api-Key': 'server-only-key',
      'X-Api-Resource-Id': 'seed-tts-2.0'
    });
    expect(requestOptions.headers['X-Api-Request-Id']).to.be.a('string');
    expect(JSON.parse(requestOptions.body)).to.deep.equal({
      user: { uid: 'cboard-api' },
      req_params: {
        text: '我想喝水。',
        speaker: 'zh_male_dayi_saturn_bigtts',
        audio_params: { format: 'mp3', sample_rate: 24000 },
        speed_ratio: 2
      }
    });
    expect(result.data.equals(Buffer.from('mp3-audio'))).to.equal(true);
    expect(result.contentType).to.equal('audio/mpeg');
    expect(result).not.to.have.property('apiKey');
  });

  it('rejects a voice outside the server allowlist before calling the API', async function() {
    let calls = 0;
    const provider = createCommunicationVolcengineTtsProvider({
      env: createEnvironment(),
      fetchImpl: async () => {
        calls += 1;
        return sseResponse([]);
      }
    });

    await expectRejected(
      provider.synthesize({ text: '需要帮助。', voice: 'private-voice' }),
      400,
      'not available'
    );
    expect(calls).to.equal(0);
  });

  it('rejects malformed, incomplete, and provider error frames without leaking details', async function() {
    expect(() => parseVolcengineTtsSse('data: {invalid}\n')).to.throw(
      'invalid audio'
    );

    const incompleteProvider = createCommunicationVolcengineTtsProvider({
      env: createEnvironment(),
      fetchImpl: async () =>
        sseResponse([
          { code: 0, data: Buffer.from('audio').toString('base64') }
        ])
    });
    const failedProvider = createCommunicationVolcengineTtsProvider({
      env: createEnvironment(),
      fetchImpl: async () =>
        sseResponse([{ code: 55000000, message: 'private provider detail' }])
    });

    await expectRejected(
      incompleteProvider.synthesize({ text: '需要帮助。' }),
      502,
      'invalid audio'
    );
    await expectRejected(
      failedProvider.synthesize({ text: '需要帮助。' }),
      502,
      'request failed'
    );
  });

  it('maps transport timeouts and HTTP rate limits to bounded errors', async function() {
    const timeoutProvider = createCommunicationVolcengineTtsProvider({
      env: createEnvironment(),
      fetchImpl: async () => {
        const error = new Error('private upstream timeout');
        error.name = 'TimeoutError';
        throw error;
      }
    });
    const rateLimitProvider = createCommunicationVolcengineTtsProvider({
      env: createEnvironment(),
      fetchImpl: async () => sseResponse([], 429)
    });

    await expectRejected(
      timeoutProvider.synthesize({ text: '需要帮助。' }),
      504,
      'timed out'
    );
    await expectRejected(
      rateLimitProvider.synthesize({ text: '需要帮助。' }),
      429,
      'rate limit'
    );
  });

  it('rejects an oversized provider response before parsing audio frames', async function() {
    const provider = createCommunicationVolcengineTtsProvider({
      env: createEnvironment(),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() {
          return 'x'.repeat(MAX_VOLCENGINE_TTS_RESPONSE_BYTES + 1);
        }
      })
    });

    await expectRejected(
      provider.synthesize({ text: '需要帮助。' }),
      502,
      'invalid audio'
    );
  });
});

async function expectRejected(promise, status, messageFragment) {
  try {
    await promise;
    throw new Error('Expected promise to reject');
  } catch (error) {
    expect(error.status).to.equal(status);
    expect(error.message).to.include(messageFragment);
    expect(error.message).not.to.include('private provider detail');
  }
}

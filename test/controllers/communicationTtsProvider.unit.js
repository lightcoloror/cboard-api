'use strict';

const chai = require('chai');
const {
  createCommunicationTtsProvider,
  resolveCommunicationTtsConfig
} = require('../../api/helpers/communicationTtsProvider');

const expect = chai.expect;

function audioResponse(data = Buffer.from('mp3-audio')) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-type'
          ? 'audio/mpeg; charset=binary'
          : null;
      }
    },
    async arrayBuffer() {
      return data;
    }
  };
}

function speechClient(create) {
  return {
    audio: {
      speech: { create }
    }
  };
}

describe('Communication TTS provider', function() {
  it('uses dedicated server-only speech settings before generic AI settings', function() {
    const config = resolveCommunicationTtsConfig({
      AI_TTS_API_KEY: 'speech-secret',
      AI_TTS_BASE_URL: 'https://speech.example/v1/',
      AI_TTS_MODEL: 'speech-model',
      AI_TTS_VOICE: 'verse',
      AI_TTS_VOICES: 'verse,alloy,verse',
      AI_TTS_TIMEOUT_MS: '3500',
      AI_API_KEY: 'generic-secret',
      AI_BASE_URL: 'https://generic.example/v1'
    });

    expect(config).to.deep.equal({
      apiKey: 'speech-secret',
      baseUrl: 'https://speech.example/v1',
      model: 'speech-model',
      voice: 'verse',
      voices: ['verse', 'alloy'],
      timeoutMs: 3500
    });
  });

  it('falls back to the generic OpenAI-compatible key without exposing it', async function() {
    let request;
    let clientOptions;
    const fetchImpl = async () => {
      throw new Error('The SDK owns the HTTP request');
    };
    class FakeOpenAI {
      constructor(options) {
        clientOptions = options;
        this.audio = {
          speech: {
            create: async body => {
              request = body;
              return audioResponse();
            }
          }
        };
      }
    }
    const provider = createCommunicationTtsProvider({
      env: {
        AI_API_KEY: 'server-only-secret',
        AI_BASE_URL: 'https://compatible.example/v1',
        AI_TTS_MODEL: 'tts-model',
        AI_TTS_VOICES: 'alloy,verse'
      },
      sdk: { OpenAI: FakeOpenAI },
      fetchImpl
    });

    const result = await provider.synthesize({
      text: '我想喝水。',
      rate: 9,
      voice: 'verse'
    });

    expect(clientOptions).to.deep.equal({
      apiKey: 'server-only-secret',
      baseURL: 'https://compatible.example/v1',
      timeout: 25000,
      maxRetries: 1,
      fetch: fetchImpl
    });
    expect(request).to.deep.equal({
      model: 'tts-model',
      input: '我想喝水。',
      voice: 'verse',
      response_format: 'mp3',
      speed: 2
    });
    expect(result.data.equals(Buffer.from('mp3-audio'))).to.equal(true);
    expect(result).not.to.have.property('apiKey');
  });

  it('rejects a client voice outside the server allowlist', async function() {
    const provider = createCommunicationTtsProvider({
      env: {
        AI_TTS_API_KEY: 'secret',
        AI_TTS_VOICE: 'alloy',
        AI_TTS_VOICES: 'alloy,verse'
      },
      client: speechClient(async () => audioResponse())
    });

    await expectRejected(
      provider.synthesize({ text: '需要帮助。', voice: 'custom-secret-voice' }),
      400,
      'not available'
    );
  });

  it('rejects non-audio and empty responses without returning upstream bodies', async function() {
    const provider = createCommunicationTtsProvider({
      env: { AI_TTS_API_KEY: 'secret' },
      client: speechClient(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        async arrayBuffer() {
          return Buffer.from('private upstream detail');
        }
      }))
    });

    await expectRejected(
      provider.synthesize({ text: '需要帮助。' }),
      502,
      'invalid audio'
    );
  });

  it('maps SDK timeout and rate-limit errors without exposing upstream details', async function() {
    const timeoutProvider = createCommunicationTtsProvider({
      env: { AI_TTS_API_KEY: 'secret' },
      client: speechClient(async () => {
        const error = new Error('private timeout detail');
        error.name = 'APIConnectionTimeoutError';
        throw error;
      })
    });
    const rateLimitProvider = createCommunicationTtsProvider({
      env: { AI_TTS_API_KEY: 'secret' },
      client: speechClient(async () => {
        const error = new Error('private quota detail');
        error.status = 429;
        throw error;
      })
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

  it('stays disabled until a server key is configured', function() {
    expect(createCommunicationTtsProvider({ env: {} })).to.equal(null);
  });
});

async function expectRejected(promise, status, messageFragment) {
  try {
    await promise;
    throw new Error('Expected promise to reject');
  } catch (error) {
    expect(error.status).to.equal(status);
    expect(error.message).to.include(messageFragment);
    expect(error.message).not.to.include('private upstream detail');
  }
}

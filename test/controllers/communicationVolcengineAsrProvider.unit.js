'use strict';

const chai = require('chai');
const {
  DEFAULT_VOLCENGINE_ASR_BASE_URL,
  DEFAULT_VOLCENGINE_ASR_RESOURCE_ID,
  MAX_VOLCENGINE_ASR_RESPONSE_BYTES,
  createCommunicationVolcengineAsrProvider,
  resolveVolcengineAsrConfig
} = require('../../api/helpers/communicationVolcengineAsrProvider');
const {
  createCommunicationDialectAsrProvider,
  validateDialectAudio
} = require('../../api/helpers/communicationDialectAsrProvider');

const expect = chai.expect;

function createMp3Audio() {
  return {
    buffer: Buffer.concat([Buffer.from('ID3'), Buffer.from('audio')]),
    mimetype: 'audio/mpeg'
  };
}

function createEnvironment(overrides = {}) {
  return {
    COMMUNICATION_DIALECT_ASR_PROVIDER: 'volcengine',
    COMMUNICATION_DIALECT_ASR_TIMEOUT_SECONDS: '35',
    VOLCENGINE_ASR_API_KEY: 'server-only-app-key',
    ...overrides
  };
}

function response({
  status = 200,
  statusCode = '20000000',
  body = {
    audio_info: { duration: 1250 },
    result: { text: ' 我想饮水。 ' }
  }
} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === 'x-api-status-code' ? statusCode : null;
      }
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    }
  };
}

describe('Communication Volcengine ASR provider', function() {
  it('requires either a new-console API key or complete legacy credentials', function() {
    expect(resolveVolcengineAsrConfig({})).to.equal(null);
    expect(
      resolveVolcengineAsrConfig({ VOLCENGINE_ASR_APP_KEY: 'app-only' })
    ).to.equal(null);

    expect(resolveVolcengineAsrConfig(createEnvironment())).to.deep.equal({
      provider: 'volcengine',
      apiKey: 'server-only-app-key',
      appKey: '',
      accessKey: '',
      baseUrl: DEFAULT_VOLCENGINE_ASR_BASE_URL,
      resourceId: DEFAULT_VOLCENGINE_ASR_RESOURCE_ID,
      engine: 'bigmodel',
      timeoutMs: 35000
    });
    expect(
      resolveVolcengineAsrConfig({
        VOLCENGINE_ASR_APP_KEY: 'legacy-app',
        VOLCENGINE_ASR_ACCESS_KEY: 'legacy-access'
      })
    ).to.include({
      apiKey: '',
      appKey: 'legacy-app',
      accessKey: 'legacy-access'
    });
  });

  it('posts bounded MP3 data using the official new-console flash API contract', async function() {
    let requestUrl;
    let requestOptions;
    const provider = createCommunicationDialectAsrProvider({
      env: createEnvironment(),
      randomUUIDImpl: () => 'request-id',
      fetchImpl: async (url, options) => {
        requestUrl = url;
        requestOptions = options;
        return response();
      }
    });
    const audio = createMp3Audio();

    const result = await provider.recognize(audio);

    expect(requestUrl).to.equal(DEFAULT_VOLCENGINE_ASR_BASE_URL);
    expect(requestOptions.headers).to.include({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Api-Key': 'server-only-app-key',
      'X-Api-Resource-Id': 'volc.bigasr.auc_turbo',
      'X-Api-Request-Id': 'request-id',
      'X-Api-Sequence': '-1'
    });
    expect(requestOptions.headers).not.to.have.property('X-Api-Access-Key');
    expect(JSON.parse(requestOptions.body)).to.deep.equal({
      user: { uid: 'request-id' },
      audio: { data: audio.buffer.toString('base64') },
      request: {
        model_name: 'bigmodel',
        enable_itn: true,
        enable_punc: true
      }
    });
    expect(requestOptions.body).not.to.include('server-only-app-key');
    expect(result).to.deep.equal({
      text: '我想饮水。',
      dialect: 'cantonese',
      engine: 'bigmodel',
      provider: 'volcengine-bigasr',
      audioDurationMs: 1250,
      audioStored: false,
      providerProcessing: true
    });
    expect(result).not.to.have.any.keys('apiKey', 'requestId');
  });

  it('supports the official legacy App-Key and Access-Key headers', async function() {
    let headers;
    const provider = createCommunicationDialectAsrProvider({
      env: createEnvironment({
        VOLCENGINE_ASR_API_KEY: '',
        VOLCENGINE_ASR_APP_KEY: 'legacy-app',
        VOLCENGINE_ASR_ACCESS_KEY: 'legacy-access'
      }),
      fetchImpl: async (url, options) => {
        headers = options.headers;
        return response();
      }
    });

    await provider.recognize(createMp3Audio());

    expect(headers).to.include({
      'X-Api-App-Key': 'legacy-app',
      'X-Api-Access-Key': 'legacy-access'
    });
    expect(headers).not.to.have.property('X-Api-Key');
  });

  it('rejects Tencent-only formats before contacting Volcengine', async function() {
    let calls = 0;
    const provider = createCommunicationDialectAsrProvider({
      env: createEnvironment(),
      fetchImpl: async () => {
        calls += 1;
        return response();
      }
    });

    await expectRejected(
      provider.recognize({
        buffer: Buffer.concat([
          Buffer.from([0, 0, 0, 24]),
          Buffer.from('ftyp'),
          Buffer.from('m4a-audio')
        ]),
        mimetype: 'audio/mp4'
      }),
      415,
      'Unsupported'
    );
    expect(calls).to.equal(0);
  });

  it('maps silence, invalid audio, overload, HTTP rate limits, and timeouts', async function() {
    await expectProviderStatus('20000003', 422, 'did not recognize');
    await expectProviderStatus('45000151', 422, 'rejected');
    await expectProviderStatus('55000031', 503, 'temporarily unavailable');
    await expectProviderStatus('', 429, 'rate limit', 429);
    await expectProviderStatus('', 503, 'temporarily unavailable', 503);

    const provider = createCommunicationDialectAsrProvider({
      env: createEnvironment(),
      fetchImpl: async () => {
        const error = new Error('private provider timeout detail');
        error.name = 'TimeoutError';
        throw error;
      }
    });
    await expectRejected(
      provider.recognize(createMp3Audio()),
      504,
      'timed out'
    );
  });

  it('rejects malformed, oversized, empty, and overlong provider output', async function() {
    const malformed = createProvider(async () =>
      response({ body: '{invalid' })
    );
    const oversized = createProvider(async () =>
      response({ body: 'x'.repeat(MAX_VOLCENGINE_ASR_RESPONSE_BYTES + 1) })
    );
    const empty = createProvider(async () =>
      response({ body: { result: { text: '   ' } } })
    );
    const overlong = createProvider(async () =>
      response({
        body: {
          audio_info: { duration: 60001 },
          result: { text: '我想饮水' }
        }
      })
    );

    await expectRejected(malformed.recognize(createMp3Audio()), 502, 'invalid');
    await expectRejected(oversized.recognize(createMp3Audio()), 502, 'invalid');
    await expectRejected(
      empty.recognize(createMp3Audio()),
      422,
      'did not recognize'
    );
    await expectRejected(overlong.recognize(createMp3Audio()), 422, 'rejected');
  });
});

function createProvider(fetchImpl) {
  return createCommunicationVolcengineAsrProvider({
    configuration: resolveVolcengineAsrConfig(createEnvironment()),
    fetchImpl,
    randomUUIDImpl: () => 'request-id',
    validateAudio: validateDialectAudio
  });
}

async function expectProviderStatus(
  statusCode,
  expectedStatus,
  message,
  httpStatus = 200
) {
  const provider = createProvider(async () =>
    response({ status: httpStatus, statusCode })
  );
  await expectRejected(
    provider.recognize(createMp3Audio()),
    expectedStatus,
    message
  );
}

async function expectRejected(promise, status, messageFragment) {
  try {
    await promise;
    throw new Error('Expected promise to reject');
  } catch (error) {
    expect(error.status).to.equal(status);
    expect(error.message).to.include(messageFragment);
    expect(error.message).not.to.include('private provider');
  }
}

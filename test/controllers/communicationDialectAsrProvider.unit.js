'use strict';

const chai = require('chai');
const {
  DIALECT_ASR_ENGINE,
  MAX_DIALECT_ASR_INPUT_BYTES,
  createCommunicationDialectAsrProvider,
  createDialectAsrClient,
  resolveDialectAsrConfiguration
} = require('../../api/helpers/communicationDialectAsrProvider');

const expect = chai.expect;

function createMp3Audio() {
  return {
    buffer: Buffer.concat([
      Buffer.from('ID3'),
      Buffer.from('caregiver-cantonese-audio')
    ]),
    mimetype: 'audio/mpeg'
  };
}

function createConfiguration() {
  return {
    provider: 'tencentcloud',
    secretId: 'server-secret-id',
    secretKey: 'server-secret-key',
    engine: DIALECT_ASR_ENGINE,
    region: '',
    timeoutSeconds: 30
  };
}

describe('Communication dialect ASR provider', function() {
  it('stays disabled until the provider and both server credentials exist', function() {
    expect(resolveDialectAsrConfiguration({})).to.equal(null);
    expect(
      resolveDialectAsrConfiguration({
        COMMUNICATION_DIALECT_ASR_PROVIDER: 'tencentcloud',
        COMMUNICATION_TENCENTCLOUD_ASR_SECRET_ID: 'id-only'
      })
    ).to.equal(null);

    expect(
      resolveDialectAsrConfiguration({
        COMMUNICATION_DIALECT_ASR_PROVIDER: 'tencentcloud',
        COMMUNICATION_TENCENTCLOUD_ASR_SECRET_ID: 'secret-id',
        COMMUNICATION_TENCENTCLOUD_ASR_SECRET_KEY: 'secret-key'
      })
    ).to.include({
      provider: 'tencentcloud',
      engine: '16k_yue',
      timeoutSeconds: 30
    });
  });

  it('keeps Tencent credentials only in the server SDK client configuration', function() {
    let clientConfiguration;
    const client = createDialectAsrClient(createConfiguration(), {
      Client: function Client(configuration) {
        clientConfiguration = configuration;
      }
    });

    expect(client).to.be.an.instanceOf(Object);
    expect(clientConfiguration.credential).to.deep.equal({
      secretId: 'server-secret-id',
      secretKey: 'server-secret-key'
    });
    expect(clientConfiguration.profile.httpProfile).to.deep.equal({
      endpoint: 'asr.tencentcloudapi.com',
      reqTimeout: 30
    });
  });

  it('sends bounded MP3 bytes to the official 16k_yue sentence API', async function() {
    let request;
    const provider = createCommunicationDialectAsrProvider({
      configuration: createConfiguration(),
      client: {
        async SentenceRecognition(value) {
          request = value;
          return {
            Result: '  我想饮水。 ',
            AudioDuration: 1250,
            RequestId: 'provider-request-id'
          };
        }
      }
    });
    const audio = createMp3Audio();

    const result = await provider.recognize(audio);

    expect(request).to.deep.equal({
      EngSerViceType: '16k_yue',
      SourceType: 1,
      VoiceFormat: 'mp3',
      Data: audio.buffer.toString('base64'),
      DataLen: audio.buffer.length,
      FilterDirty: 0,
      FilterModal: 0,
      FilterPunc: 0,
      ConvertNumMode: 1,
      WordInfo: 0
    });
    expect(result).to.deep.equal({
      text: '我想饮水。',
      dialect: 'cantonese',
      engine: '16k_yue',
      provider: 'tencentcloud-asr',
      audioDurationMs: 1250,
      audioStored: false,
      providerProcessing: true
    });
    expect(result).not.to.have.property('RequestId');
  });

  it('rejects unsupported and oversized audio before contacting Tencent', async function() {
    let calls = 0;
    const provider = createCommunicationDialectAsrProvider({
      configuration: createConfiguration(),
      client: {
        async SentenceRecognition() {
          calls += 1;
          return { Result: '不应调用' };
        }
      }
    });

    let unsupported;
    let oversized;
    try {
      await provider.recognize({
        buffer: Buffer.from('WEBM'),
        mimetype: 'audio/webm'
      });
    } catch (error) {
      unsupported = error;
    }
    try {
      await provider.recognize({
        buffer: Buffer.alloc(MAX_DIALECT_ASR_INPUT_BYTES + 1),
        mimetype: 'audio/pcm'
      });
    } catch (error) {
      oversized = error;
    }

    expect(calls).to.equal(0);
    expect(unsupported.status).to.equal(415);
    expect(oversized.status).to.equal(413);
  });

  it('rejects audio whose Tencent Base64 payload exceeds 3 MiB', async function() {
    let calls = 0;
    const provider = createCommunicationDialectAsrProvider({
      configuration: createConfiguration(),
      client: {
        async SentenceRecognition() {
          calls += 1;
          return { Result: '不应调用' };
        }
      }
    });
    const buffer = Buffer.alloc(
      Math.floor((MAX_DIALECT_ASR_INPUT_BYTES * 3) / 4) + 1
    );
    buffer.write('ID3', 0, 'ascii');

    let error;
    try {
      await provider.recognize({ buffer, mimetype: 'audio/mpeg' });
    } catch (caught) {
      error = caught;
    }

    expect(calls).to.equal(0);
    expect(error.status).to.equal(413);
    expect(error.message).to.include('Tencent encoded');
  });

  it('returns a reviewable error when no speech was recognized', async function() {
    const provider = createCommunicationDialectAsrProvider({
      configuration: createConfiguration(),
      client: {
        async SentenceRecognition() {
          return { Result: '   ' };
        }
      }
    });

    let error;
    try {
      await provider.recognize(createMp3Audio());
    } catch (caught) {
      error = caught;
    }

    expect(error.status).to.equal(422);
    expect(error.message).to.contain('did not recognize');
  });

  it('maps provider rate limits without leaking the upstream error', async function() {
    const provider = createCommunicationDialectAsrProvider({
      configuration: createConfiguration(),
      client: {
        async SentenceRecognition() {
          const error = new Error('internal provider detail');
          error.code = 'RequestLimitExceeded';
          throw error;
        }
      }
    });

    let error;
    try {
      await provider.recognize(createMp3Audio());
    } catch (caught) {
      error = caught;
    }

    expect(error.status).to.equal(429);
    expect(error.message).to.equal('Dialect ASR rate limit reached');
  });
});

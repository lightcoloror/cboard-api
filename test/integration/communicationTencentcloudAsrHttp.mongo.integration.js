'use strict';

const mongoUrl = process.env.COMMUNICATION_TENCENTCLOUD_ASR_HTTP_MONGO_TEST_URL;
const providerOrigin = 'https://asr.tencentcloudapi.com';

if (mongoUrl) {
  process.env.NODE_ENV = 'test';
  process.env.MONGO_URL = mongoUrl;
  process.env.PORT =
    process.env.COMMUNICATION_TENCENTCLOUD_ASR_HTTP_TEST_PORT || '19130';
  process.env.API_SESSION_SECRET = 'tencentcloud-asr-integration-session';
  process.env.JWT_SECRET = 'tencentcloud-asr-integration-jwt';
  process.env.COMMUNICATION_DIALECT_ASR_PROVIDER = 'tencentcloud';
  process.env.COMMUNICATION_TENCENTCLOUD_ASR_SECRET_ID = 'AKIDEXAMPLE';
  process.env.COMMUNICATION_TENCENTCLOUD_ASR_SECRET_KEY = 'secret-example';
  process.env.COMMUNICATION_TENCENTCLOUD_ASR_REGION = '';
  process.env.COMMUNICATION_DIALECT_ASR_TIMEOUT_SECONDS = '5';
  process.env.COMMUNICATION_ENHANCEMENT_RATE_LIMIT_ENABLED = 'false';
  process.env.COMMUNICATION_AI_TOKEN_QUOTA_ENABLED = 'false';
  const noProxy = [
    String(process.env.NO_PROXY || process.env.no_proxy || '').trim(),
    'asr.tencentcloudapi.com'
  ]
    .filter(Boolean)
    .join(',');
  process.env.NO_PROXY = noProxy;
  process.env.no_proxy = noProxy;
}

const chai = require('chai');
const nock = require('nock');
const request = require('supertest');
const helper = require('../helper');

const expect = chai.expect;
const describeWithMongo = mongoUrl ? describe : describe.skip;

describeWithMongo(
  'Communication Tencent Cloud ASR HTTP with Mongo',
  function() {
    this.timeout(30000);

    const audio = Buffer.concat([
      Buffer.from('ID3', 'ascii'),
      Buffer.from('-picinterpreter-tencent-asr-integration', 'utf8')
    ]);
    let app;
    let capturedProviderBody;
    let user;

    before(async function() {
      helper.prepareNodemailerMock();
      app = require('../../app');
      const account = {
        ...helper.userData,
        email: helper.generateEmail()
      };
      const created = await request(app)
        .post('/user')
        .set('X-Forwarded-For', '127.0.0.1')
        .send(account)
        .expect(200);
      await request(app)
        .post(`/user/activate/${created.body.url}`)
        .send('')
        .expect(200);
      const login = await request(app)
        .post('/user/login')
        .set('X-Forwarded-For', '127.0.0.1')
        .send(account)
        .expect(200);
      user = { token: login.body.authToken };
    });

    after(async function() {
      nock.cleanAll();
      helper.prepareNodemailerMock(true);
      await helper.deleteMochaUsers();
    });

    it('rejects anonymous audio before creating a provider request', async function() {
      await request(app)
        .post('/gpt/communication/dialect-asr')
        .attach('audio', audio, {
          filename: 'caregiver.mp3',
          contentType: 'audio/mpeg'
        })
        .expect('Content-Type', /json/)
        .expect(403);

      expect(nock.pendingMocks()).to.deep.equal([]);
    });

    it('returns private editable text through the official signed SDK request', async function() {
      nock(providerOrigin)
        .post('/')
        .matchHeader('x-tc-action', 'SentenceRecognition')
        .matchHeader('x-tc-version', '2019-06-14')
        .matchHeader(
          'authorization',
          /^TC3-HMAC-SHA256 Credential=AKIDEXAMPLE\//
        )
        .reply(function(_uri, body) {
          capturedProviderBody = body;
          return [
            200,
            {
              Response: {
                Result: ' 我想饮水。 ',
                AudioDuration: 1380,
                RequestId: 'integration-request-id'
              }
            }
          ];
        });

      const response = await request(app)
        .post('/gpt/communication/dialect-asr')
        .set('Authorization', `Bearer ${user.token}`)
        .attach('audio', audio, {
          filename: 'caregiver.mp3',
          contentType: 'audio/mpeg'
        })
        .expect('Content-Type', /json/)
        .expect('Cache-Control', 'no-store, private')
        .expect('X-Content-Type-Options', 'nosniff')
        .expect(200);

      expect(response.body).to.deep.equal({
        text: '我想饮水。',
        dialect: 'cantonese',
        engine: '16k_yue',
        provider: 'tencentcloud-asr',
        audioDurationMs: 1380,
        audioStored: false,
        providerProcessing: true
      });
      expect(response.body).not.to.have.any.keys('RequestId', 'secretId');
      expect(capturedProviderBody).to.deep.equal({
        EngSerViceType: '16k_yue',
        SourceType: 1,
        VoiceFormat: 'mp3',
        Data: audio.toString('base64'),
        DataLen: audio.length,
        FilterDirty: 0,
        FilterModal: 0,
        FilterPunc: 0,
        ConvertNumMode: 1,
        WordInfo: 0
      });
      expect(JSON.stringify(capturedProviderBody)).not.to.include(
        'secret-example'
      );
      expect(nock.isDone()).to.equal(true);
    });
  }
);

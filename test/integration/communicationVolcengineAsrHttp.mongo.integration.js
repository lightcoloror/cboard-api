'use strict';

const mongoUrl = process.env.COMMUNICATION_VOLCENGINE_ASR_HTTP_MONGO_TEST_URL;
const providerPort =
  process.env.COMMUNICATION_VOLCENGINE_ASR_PROVIDER_TEST_PORT || '19129';
const providerPath = '/api/v3/auc/bigmodel/recognize/flash';

if (mongoUrl) {
  process.env.NODE_ENV = 'test';
  process.env.MONGO_URL = mongoUrl;
  process.env.PORT =
    process.env.COMMUNICATION_VOLCENGINE_ASR_HTTP_TEST_PORT || '19128';
  process.env.API_SESSION_SECRET = 'volcengine-asr-integration-session';
  process.env.JWT_SECRET = 'volcengine-asr-integration-jwt';
  process.env.COMMUNICATION_DIALECT_ASR_PROVIDER = 'volcengine';
  process.env.VOLCENGINE_ASR_API_KEY = 'server-only-integration-key';
  process.env.VOLCENGINE_ASR_BASE_URL = `http://127.0.0.1:${providerPort}${providerPath}`;
  process.env.VOLCENGINE_ASR_RESOURCE_ID = 'volc.bigasr.auc_turbo';
  process.env.COMMUNICATION_DIALECT_ASR_TIMEOUT_SECONDS = '5';
  process.env.COMMUNICATION_ENHANCEMENT_RATE_LIMIT_ENABLED = 'false';
  process.env.COMMUNICATION_AI_TOKEN_QUOTA_ENABLED = 'false';
}

const chai = require('chai');
const http = require('http');
const request = require('supertest');
const helper = require('../helper');

const expect = chai.expect;
const describeWithMongo = mongoUrl ? describe : describe.skip;

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

describeWithMongo('Communication Volcengine ASR HTTP with Mongo', function() {
  this.timeout(30000);

  const audio = Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from('-picinterpreter-asr-integration', 'utf8')
  ]);
  let app;
  let capturedRequest;
  let providerCalls = 0;
  let providerServer;
  let user;

  before(async function() {
    helper.prepareNodemailerMock();
    providerServer = http.createServer(async (req, res) => {
      providerCalls += 1;
      capturedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(await readRequestBody(req))
      };
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Api-Status-Code': '20000000'
      });
      res.end(
        JSON.stringify({
          audio_info: { duration: 1380 },
          result: { text: ' 我想饮水。 ' }
        })
      );
    });
    await new Promise((resolve, reject) => {
      providerServer.once('error', reject);
      providerServer.listen(Number(providerPort), '127.0.0.1', resolve);
    });

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
    helper.prepareNodemailerMock(true);
    await helper.deleteMochaUsers();
    if (providerServer) {
      await new Promise(resolve => providerServer.close(resolve));
    }
  });

  it('rejects anonymous audio before contacting Volcengine', async function() {
    await request(app)
      .post('/gpt/communication/dialect-asr')
      .attach('audio', audio, {
        filename: 'caregiver.mp3',
        contentType: 'audio/mpeg'
      })
      .expect('Content-Type', /json/)
      .expect(403);

    expect(providerCalls).to.equal(0);
  });

  it('returns private editable text through the authenticated contract', async function() {
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
      engine: 'bigmodel',
      provider: 'volcengine-bigasr',
      audioDurationMs: 1380,
      audioStored: false,
      providerProcessing: true
    });
    expect(response.body).not.to.have.any.keys('apiKey', 'requestId');
    expect(providerCalls).to.equal(1);
    expect(capturedRequest).to.deep.include({
      method: 'POST',
      url: providerPath
    });
    expect(capturedRequest.headers).to.include({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-api-key': 'server-only-integration-key',
      'x-api-resource-id': 'volc.bigasr.auc_turbo',
      'x-api-sequence': '-1'
    });
    expect(capturedRequest.headers['x-api-request-id']).to.match(
      /^[a-f0-9-]{36}$/
    );
    expect(capturedRequest.body).to.deep.equal({
      user: { uid: capturedRequest.headers['x-api-request-id'] },
      audio: { data: audio.toString('base64') },
      request: {
        model_name: 'bigmodel',
        enable_itn: true,
        enable_punc: true
      }
    });
    expect(JSON.stringify(capturedRequest.body)).not.to.include(
      'server-only-integration-key'
    );
  });
});

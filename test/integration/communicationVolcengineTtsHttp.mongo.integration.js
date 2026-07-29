'use strict';

const mongoUrl = process.env.COMMUNICATION_VOLCENGINE_TTS_HTTP_MONGO_TEST_URL;
const providerPort =
  process.env.COMMUNICATION_VOLCENGINE_TTS_PROVIDER_TEST_PORT || '19127';
const providerPath = '/api/v3/tts/unidirectional/sse';

if (mongoUrl) {
  process.env.NODE_ENV = 'test';
  process.env.MONGO_URL = mongoUrl;
  process.env.PORT =
    process.env.COMMUNICATION_VOLCENGINE_TTS_HTTP_TEST_PORT || '19126';
  process.env.API_SESSION_SECRET = 'volcengine-tts-integration-session';
  process.env.JWT_SECRET = 'volcengine-tts-integration-jwt';
  process.env.AI_TTS_PROVIDER = 'volcengine';
  process.env.VOLCENGINE_TTS_API_KEY = 'server-only-integration-key';
  process.env.VOLCENGINE_TTS_BASE_URL = `http://127.0.0.1:${providerPort}${providerPath}`;
  process.env.VOLCENGINE_TTS_RESOURCE_ID = 'seed-tts-2.0';
  process.env.VOLCENGINE_TTS_VOICE = 'zh_female_vv_uranus_bigtts';
  process.env.VOLCENGINE_TTS_VOICES = 'zh_female_vv_uranus_bigtts';
  process.env.VOLCENGINE_TTS_TIMEOUT_MS = '5000';
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

describeWithMongo('Communication Volcengine TTS HTTP with Mongo', function() {
  this.timeout(30000);

  const audio = Buffer.from('ID3-picinterpreter-tts-integration', 'utf8');
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
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({
          code: 0,
          data: audio.toString('base64')
        })}\n\ndata: ${JSON.stringify({ code: 20000000, message: 'OK' })}\n\n`
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
    const activated = await request(app)
      .post(`/user/activate/${created.body.url}`)
      .send('')
      .expect(200);
    const login = await request(app)
      .post('/user/login')
      .set('X-Forwarded-For', '127.0.0.1')
      .send(account)
      .expect(200);
    user = {
      userId: activated.body.userid,
      token: login.body.authToken
    };
  });

  after(async function() {
    helper.prepareNodemailerMock(true);
    await helper.deleteMochaUsers();
    if (providerServer) {
      await new Promise(resolve => providerServer.close(resolve));
    }
  });

  it('rejects anonymous speech before contacting Volcengine', async function() {
    await request(app)
      .post('/gpt/communication/speech')
      .send({ text: 'I need water' })
      .expect('Content-Type', /json/)
      .expect(403);

    expect(providerCalls).to.equal(0);
  });

  it('returns private MP3 through the authenticated Volcengine contract', async function() {
    const response = await request(app)
      .post('/gpt/communication/speech')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        text: 'I need water',
        voice: 'zh_female_vv_uranus_bigtts',
        rate: 1.25
      })
      .expect('Content-Type', /audio\/mpeg/)
      .expect('Cache-Control', 'no-store, private')
      .expect('X-Content-Type-Options', 'nosniff')
      .expect(200);

    expect(response.body).to.deep.equal(audio);
    expect(providerCalls).to.equal(1);
    expect(capturedRequest).to.deep.include({
      method: 'POST',
      url: providerPath
    });
    expect(capturedRequest.headers).to.include({
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'x-api-key': 'server-only-integration-key',
      'x-api-resource-id': 'seed-tts-2.0'
    });
    expect(capturedRequest.headers['x-api-request-id']).to.match(
      /^[a-f0-9-]{36}$/
    );
    expect(capturedRequest.body).to.deep.equal({
      user: { uid: 'cboard-api' },
      req_params: {
        text: 'I need water',
        speaker: 'zh_female_vv_uranus_bigtts',
        audio_params: { format: 'mp3', sample_rate: 24000 },
        speed_ratio: 1.25
      }
    });
  });
});

'use strict';

const mongoUrl = process.env.COMMUNICATION_AI_HTTP_QUOTA_MONGO_TEST_URL;
const providerOrigin = 'https://openai-compatible.integration.test';

if (mongoUrl) {
  process.env.NODE_ENV = 'test';
  process.env.MONGO_URL = mongoUrl;
  process.env.PORT =
    process.env.COMMUNICATION_AI_HTTP_QUOTA_TEST_PORT || '19123';
  process.env.API_SESSION_SECRET = 'ai-http-quota-integration-session';
  process.env.JWT_SECRET = 'ai-http-quota-integration-jwt';
  process.env.AI_API_KEY = 'ai-http-quota-provider-secret';
  process.env.AI_BASE_URL = `${providerOrigin}/v1`;
  process.env.AI_MODEL = 'integration-chat-model';
  process.env.AI_REQUEST_TIMEOUT_MS = '5000';
  process.env.COMMUNICATION_ENHANCEMENT_RATE_LIMIT_ENABLED = 'false';
  process.env.COMMUNICATION_AI_TOKEN_QUOTA_ENABLED = 'true';
  process.env.COMMUNICATION_AI_MONTHLY_TOKEN_QUOTA = '100';
  process.env.COMMUNICATION_AI_TEXT_TOKEN_RESERVATION = '40';
  process.env.COMMUNICATION_AI_IMAGE_TOKEN_RESERVATION = '80';
}

const chai = require('chai');
const nock = require('nock');
const request = require('supertest');
const helper = require('../helper');

const expect = chai.expect;
const describeWithMongo = mongoUrl ? describe : describe.skip;

function providerResponse(content, totalTokens) {
  return {
    id: `chatcmpl-integration-${totalTokens}`,
    object: 'chat.completion',
    created: 1785286800,
    model: 'integration-provider-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: Math.max(0, totalTokens - 5),
      completion_tokens: Math.min(5, totalTokens),
      total_tokens: totalTokens
    }
  };
}

describeWithMongo('Communication AI HTTP token quota with Mongo', function() {
  this.timeout(30000);

  let app;
  let user;

  async function getUsage() {
    const response = await request(app)
      .get('/gpt/communication/usage')
      .set('Authorization', `Bearer ${user.token}`)
      .expect('Content-Type', /json/)
      .expect(200);
    return response.body;
  }

  async function waitForConsumedTokens(expected) {
    let usage;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      usage = await getUsage();
      if (usage.tokenQuota.consumedTokens === expected) return usage;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(usage.tokenQuota.consumedTokens).to.equal(expected);
    return usage;
  }

  before(async function() {
    helper.prepareNodemailerMock();
    app = require('../../app');
    helper.userData.email = helper.generateEmail();
    user = await helper.prepareUser(app, {
      email: helper.userData.email,
      role: 'user'
    });
  });

  after(async function() {
    nock.cleanAll();
    helper.prepareNodemailerMock(true);
    if (user) await helper.deleteMochaUsers();
  });

  it('settles usage, releases failures, and rejects before the provider', async function() {
    nock(providerOrigin)
      .post('/v1/chat/completions')
      .matchHeader('authorization', 'Bearer ai-http-quota-provider-secret')
      .reply(200, providerResponse('1. 我想喝水。\n2. 请给我水。', 25));

    const first = await request(app)
      .post('/gpt/communication/sentences')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        candidateCount: 2,
        pictogramLabels: ['我想', '喝', '水']
      })
      .expect('Content-Type', /json/)
      .expect(200);
    expect(first.body.candidates).to.deep.equal(['我想喝水。', '请给我水。']);
    expect(await waitForConsumedTokens(25)).to.include({
      providerReported: true,
      totalTokens: 25
    });

    nock(providerOrigin)
      .post('/v1/chat/completions')
      .times(2)
      .reply(500, { error: { message: 'bounded provider failure' } });

    await request(app)
      .post('/gpt/communication/sentences')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ pictogramLabels: ['继续', '训练'] })
      .expect('Content-Type', /json/)
      .expect(500);
    expect((await waitForConsumedTokens(25)).totalTokens).to.equal(25);

    nock(providerOrigin)
      .post('/v1/chat/completions')
      .reply(200, providerResponse('我需要休息。', 60));

    await request(app)
      .post('/gpt/communication/sentences')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ pictogramLabels: ['我', '需要', '休息'] })
      .expect('Content-Type', /json/)
      .expect(200);

    const settled = await waitForConsumedTokens(85);
    expect(settled).to.include({
      providerReported: true,
      totalTokens: 85
    });
    expect(settled.tokenQuota).to.include({
      consumedTokens: 85,
      limitTokens: 100,
      remainingTokens: 15
    });

    const rejected = await request(app)
      .post('/gpt/communication/sentences')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ pictogramLabels: ['不要', '继续'] })
      .expect('Content-Type', /json/)
      .expect(429);
    expect(rejected.body).to.deep.equal({
      error: {
        code: 'COMMUNICATION_AI_TOKEN_QUOTA_EXCEEDED',
        message: 'Monthly communication AI token quota exceeded'
      }
    });
    expect(nock.isDone()).to.equal(true);

    const finalUsage = await waitForConsumedTokens(85);
    expect(finalUsage.totalTokens).to.equal(85);
    expect(finalUsage.tokenQuota.remainingTokens).to.equal(15);
  });
});

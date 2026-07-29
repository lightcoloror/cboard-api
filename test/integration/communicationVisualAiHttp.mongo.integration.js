'use strict';

const crypto = require('crypto');

const mongoUrl = process.env.COMMUNICATION_VISUAL_AI_HTTP_MONGO_TEST_URL;
const providerOrigin = 'https://openai-compatible-visual.integration.test';

if (mongoUrl) {
  process.env.NODE_ENV = 'test';
  process.env.MONGO_URL = mongoUrl;
  process.env.PORT =
    process.env.COMMUNICATION_VISUAL_AI_HTTP_TEST_PORT || '19131';
  process.env.API_SESSION_SECRET = 'visual-ai-integration-session';
  process.env.JWT_SECRET = 'visual-ai-integration-jwt';
  process.env.AI_API_KEY = 'visual-ai-provider-secret';
  process.env.AI_BASE_URL = `${providerOrigin}/v1`;
  process.env.AI_MODEL = 'integration-vision-model';
  process.env.AI_IMAGE_MODEL = 'gpt-image-1';
  process.env.AI_REQUEST_TIMEOUT_MS = '5000';
  process.env.AI_IMAGE_REQUEST_TIMEOUT_MS = '10000';
  process.env.COMMUNICATION_ENHANCEMENT_RATE_LIMIT_ENABLED = 'false';
  process.env.COMMUNICATION_AI_TOKEN_QUOTA_ENABLED = 'true';
  process.env.COMMUNICATION_AI_MONTHLY_TOKEN_QUOTA = '1000';
  process.env.COMMUNICATION_AI_TEXT_TOKEN_RESERVATION = '100';
  process.env.COMMUNICATION_AI_IMAGE_TOKEN_RESERVATION = '200';
  const noProxy = [
    String(process.env.NO_PROXY || process.env.no_proxy || '').trim(),
    'openai-compatible-visual.integration.test'
  ]
    .filter(Boolean)
    .join(',');
  process.env.NO_PROXY = noProxy;
  process.env.no_proxy = noProxy;
}

const chai = require('chai');
const nock = require('nock');
const request = require('supertest');
const sharp = require('sharp');
const helper = require('../helper');

const expect = chai.expect;
const describeWithMongo = mongoUrl ? describe : describe.skip;

function chatResponse(content, totalTokens) {
  return {
    id: `chatcmpl-visual-${totalTokens}`,
    object: 'chat.completion',
    created: 1785286800,
    model: 'integration-vision-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: totalTokens - 5,
      completion_tokens: 5,
      total_tokens: totalTokens
    }
  };
}

function expectPrivateResponse(response) {
  expect(response.headers['cache-control']).to.equal('no-store, private');
  expect(response.headers['x-content-type-options']).to.equal('nosniff');
}

function getImageUrl(body) {
  return body.messages[1].content.find(item => item.type === 'image_url')
    .image_url.url;
}

describeWithMongo('Communication visual AI HTTP with Mongo', function() {
  this.timeout(30000);

  let app;
  let inputImage;
  let generatedImage;
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
    inputImage = await sharp({
      create: {
        width: 5,
        height: 4,
        channels: 3,
        background: { r: 245, g: 210, b: 40 }
      }
    })
      .jpeg()
      .toBuffer();
    generatedImage = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 4,
        background: { r: 40, g: 160, b: 90, alpha: 1 }
      }
    })
      .png()
      .toBuffer();
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

  it('rejects an anonymous image before contacting the provider', async function() {
    await request(app)
      .post('/gpt/communication/ocr')
      .attach('image', inputImage, {
        filename: 'private-family-note.jpg',
        contentType: 'image/jpeg'
      })
      .expect('Content-Type', /json/)
      .expect(403);

    expect(nock.pendingMocks()).to.deep.equal([]);
  });

  it('keeps OCR and metadata transient while settling provider usage', async function() {
    const providerBodies = [];
    nock(providerOrigin)
      .post('/v1/chat/completions')
      .matchHeader('authorization', 'Bearer visual-ai-provider-secret')
      .reply(function(_uri, body) {
        providerBodies.push(body);
        return [200, chatResponse('我想吃苹果', 20)];
      });
    nock(providerOrigin)
      .post('/v1/chat/completions')
      .matchHeader('authorization', 'Bearer visual-ai-provider-secret')
      .reply(function(_uri, body) {
        providerBodies.push(body);
        return [
          200,
          chatResponse(
            '{"label":"苹果","synonyms":["水果"],"category":"食物"}',
            25
          )
        ];
      });

    const ocr = await request(app)
      .post('/gpt/communication/ocr')
      .set('Authorization', `Bearer ${user.token}`)
      .attach('image', inputImage, {
        filename: 'private-family-note.jpg',
        contentType: 'image/jpeg'
      })
      .expect('Content-Type', /json/)
      .expect(200);
    expectPrivateResponse(ocr);
    expect(ocr.body).to.deep.equal({
      text: '我想吃苹果',
      provider: 'cboard-api-ai',
      sourceStored: false
    });

    const metadata = await request(app)
      .post('/gpt/communication/pictogram-metadata')
      .set('Authorization', `Bearer ${user.token}`)
      .attach('image', inputImage, {
        filename: 'private-family-note.jpg',
        contentType: 'image/jpeg'
      })
      .expect('Content-Type', /json/)
      .expect(200);
    expectPrivateResponse(metadata);
    expect(metadata.body).to.deep.equal({
      label: '苹果',
      synonyms: ['水果'],
      category: '食物',
      provider: 'cboard-api-ai',
      sourceStored: false
    });

    const expectedDataUrl = `data:image/jpeg;base64,${inputImage.toString(
      'base64'
    )}`;
    expect(providerBodies).to.have.length(2);
    providerBodies.forEach(body => {
      expect(getImageUrl(body)).to.equal(expectedDataUrl);
      const serialized = JSON.stringify(body);
      expect(serialized).not.to.include('private-family-note.jpg');
      expect(serialized).not.to.include('visual-ai-provider-secret');
    });
    expect((await waitForConsumedTokens(45)).totalTokens).to.equal(45);
  });

  it('returns a bounded private pictogram draft and settles image usage', async function() {
    let providerBody;
    nock(providerOrigin)
      .post('/v1/images/generations')
      .matchHeader('authorization', 'Bearer visual-ai-provider-secret')
      .reply(function(_uri, body) {
        providerBody = body;
        return [
          200,
          {
            created: 1785286800,
            data: [{ b64_json: generatedImage.toString('base64') }],
            usage: {
              input_tokens: 12,
              output_tokens: 20,
              total_tokens: 32
            }
          }
        ];
      });

    const response = await request(app)
      .post('/gpt/communication/pictogram-generation')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ label: '紧急求助' })
      .expect('Content-Type', /json/)
      .expect(200);
    expectPrivateResponse(response);
    expect(response.body).to.include({
      mimeType: 'image/png',
      provider: 'openai-compatible',
      model: 'gpt-image-1',
      useScope: 'device-private',
      sourceStored: false,
      publicLicenseDeclared: false,
      providerTermsApply: true
    });
    expect(response.body.generationId)
      .to.be.a('string')
      .and.not.equal('');
    const normalized = await sharp(
      Buffer.from(response.body.imageBase64, 'base64')
    ).metadata();
    expect(normalized).to.include({ format: 'png', width: 300, height: 300 });

    expect(providerBody).to.include({
      model: 'gpt-image-1',
      n: 1,
      size: '1024x1024',
      background: 'opaque',
      output_format: 'png',
      quality: 'low'
    });
    expect(providerBody.prompt).to.include('no written words');
    expect(providerBody.prompt).to.include('紧急求助');
    expect(providerBody.user).to.equal(
      crypto
        .createHash('sha256')
        .update(String(user.userId))
        .digest('hex')
    );
    expect(providerBody.user).not.to.equal(String(user.userId));
    expect(JSON.stringify(providerBody)).not.to.include(
      'visual-ai-provider-secret'
    );
    expect((await waitForConsumedTokens(77)).totalTokens).to.equal(77);
    expect(nock.isDone()).to.equal(true);
  });
});

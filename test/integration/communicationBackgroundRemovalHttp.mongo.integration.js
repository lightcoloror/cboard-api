'use strict';

const mongoUrl =
  process.env.COMMUNICATION_BACKGROUND_REMOVAL_HTTP_MONGO_TEST_URL;
const providerOrigin = 'https://rembg.integration.test';

if (mongoUrl) {
  process.env.NODE_ENV = 'test';
  process.env.MONGO_URL = mongoUrl;
  process.env.PORT =
    process.env.COMMUNICATION_BACKGROUND_REMOVAL_HTTP_TEST_PORT || '19124';
  process.env.API_SESSION_SECRET = 'background-removal-integration-session';
  process.env.JWT_SECRET = 'background-removal-integration-jwt';
  process.env.BACKGROUND_REMOVAL_PROVIDER = 'rembg';
  process.env.BACKGROUND_REMOVAL_API_URL = `${providerOrigin}/api/remove`;
  process.env.BACKGROUND_REMOVAL_TIMEOUT_MS = '5000';
  process.env.COMMUNICATION_ENHANCEMENT_RATE_LIMIT_ENABLED = 'false';
  process.env.COMMUNICATION_AI_TOKEN_QUOTA_ENABLED = 'false';
  const noProxy = [
    String(process.env.NO_PROXY || process.env.no_proxy || '').trim(),
    'rembg.integration.test'
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

describeWithMongo(
  'Communication background removal HTTP with Mongo',
  function() {
    this.timeout(30000);

    let app;
    let inputImage;
    let outputImage;
    let providerRequestBody;
    let user;

    before(async function() {
      helper.prepareNodemailerMock();
      inputImage = await sharp({
        create: {
          width: 4,
          height: 3,
          channels: 3,
          background: { r: 245, g: 245, b: 245 }
        }
      })
        .jpeg()
        .toBuffer();
      outputImage = await sharp({
        create: {
          width: 4,
          height: 3,
          channels: 4,
          background: { r: 20, g: 80, b: 140, alpha: 0.5 }
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

    it('rejects an anonymous upload before contacting the provider', async function() {
      await request(app)
        .post('/gpt/communication/background-removal')
        .attach('image', inputImage, {
          filename: 'family-photo.jpg',
          contentType: 'image/jpeg'
        })
        .expect('Content-Type', /json/)
        .expect(403);

      expect(nock.pendingMocks()).to.deep.equal([]);
    });

    it('returns a transient transparent candidate to an authenticated user', async function() {
      nock(providerOrigin)
        .post('/api/remove')
        .matchHeader('content-type', /multipart\/form-data; boundary=/)
        .reply(function(_uri, body) {
          const serializedBody = String(body);
          providerRequestBody = Buffer.isBuffer(body)
            ? body.toString('latin1')
            : /^[a-f0-9]+$/i.test(serializedBody) &&
              serializedBody.length % 2 === 0
            ? Buffer.from(serializedBody, 'hex').toString('latin1')
            : serializedBody;
          return [200, outputImage, { 'Content-Type': 'image/png' }];
        });

      const response = await request(app)
        .post('/gpt/communication/background-removal')
        .set('Authorization', `Bearer ${user.token}`)
        .attach('image', inputImage, {
          filename: 'family-photo.jpg',
          contentType: 'image/jpeg'
        })
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body).to.include({
        mimeType: 'image/png',
        width: 4,
        height: 3,
        provider: 'rembg',
        sourceStored: false,
        originalRetained: true
      });
      expect(response.headers['cache-control']).to.equal('no-store, private');
      expect(response.headers['x-content-type-options']).to.equal('nosniff');
      expect(Buffer.from(response.body.imageBase64, 'base64')).to.deep.equal(
        outputImage
      );
      expect(providerRequestBody).to.include('name="file"');
      expect(providerRequestBody).to.include(
        'filename="communication-image.jpg"'
      );
      expect(nock.isDone()).to.equal(true);
    });
  }
);

'use strict';

const bodyParser = require('body-parser');
const chai = require('chai');
const express = require('express');
const request = require('supertest');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');

const expect = chai.expect;

function createPhrase(overrides = {}) {
  return {
    id: 'phrase-water',
    sentence: '我要喝水',
    output: [{ id: 'water', label: '水' }],
    usageCount: 1,
    contractVersion: 1,
    createdAt: 10,
    lastUsedAt: 15,
    updatedAt: 20,
    baseVersion: 0,
    ...overrides
  };
}

describe('Communication saved phrase route', function() {
  let app;

  before(function(done) {
    app = express();
    app.use(bodyParser.json());

    swaggerTools.initializeMiddleware(
      YAML.load('./api/swagger/swagger.yaml'),
      function initialize(middleware) {
        app.use(middleware.swaggerMetadata());
        app.use(middleware.swaggerValidator());
        app.use(
          middleware.swaggerRouter({
            controllers:
              './test/fixtures/communicationSavedPhrasesControllers',
            useStubs: false
          })
        );
        app.use(function handleError(error, req, res, next) {
          if (!error) return next();
          return res.status(error.status || 400).json({
            error: { message: error.message }
          });
        });
        done();
      }
    );
  });

  it('accepts a bounded public saved phrase', async function() {
    const response = await request(app)
      .post('/communication/saved-phrases/sync')
      .send({ phrases: [createPhrase()] })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body.acceptedCount).to.equal(1);
    expect(response.body.phrases[0]).to.include({
      id: 'phrase-water',
      serverVersion: 1,
      conflicted: false
    });
  });

  it('rejects private maintenance fields', async function() {
    await request(app)
      .post('/communication/saved-phrases/sync')
      .send({
        phrases: [
          createPhrase({
            privateRecordingPath: 'wxfile://private/voice.mp3'
          })
        ]
      })
      .expect(400);
  });

  it('rejects a device-local image URL', async function() {
    await request(app)
      .post('/communication/saved-phrases/sync')
      .send({
        phrases: [
          createPhrase({
            output: [
              {
                id: 'private-water',
                label: '家庭水杯',
                image: 'wxfile://private/water.png'
              }
            ]
          })
        ]
      })
      .expect(400);
  });

  it('rejects an oversized sync batch', async function() {
    await request(app)
      .post('/communication/saved-phrases/sync')
      .send({
        phrases: Array.from({ length: 101 }, (value, index) =>
          createPhrase({ id: `phrase-${index}` })
        )
      })
      .expect(400);
  });

  it('accepts a bounded saved phrase deletion', async function() {
    const response = await request(app)
      .delete('/communication/saved-phrases')
      .send({ phraseIds: ['phrase-water'] })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body.deletedCount).to.equal(1);
    expect(response.body.deletedPhraseIds).to.deep.equal([
      'phrase-water'
    ]);
  });

  it('rejects private fields on deletion', async function() {
    await request(app)
      .delete('/communication/saved-phrases')
      .send({
        phraseIds: ['phrase-water'],
        privateRecordingPaths: ['wxfile://private/voice.mp3']
      })
      .expect(400);
  });
});

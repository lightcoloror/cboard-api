'use strict';

const bodyParser = require('body-parser');
const chai = require('chai');
const express = require('express');
const request = require('supertest');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');

const pictogramSearch = require('../../api/helpers/pictogramSearch');

const expect = chai.expect;

describe('Pictogram routes', function() {
  let app;
  let originalSearch;
  let originalLoadImage;
  let originalLoadGlobalSymbolsImage;
  let originalLoadOpenSymbolsImage;
  let originalSearchGlobalSymbols;

  before(function(done) {
    originalSearch = pictogramSearch.searchRuntimePictograms;
    originalLoadImage = pictogramSearch.loadArasaacImage;
    originalLoadGlobalSymbolsImage = pictogramSearch.loadGlobalSymbolsImage;
    originalLoadOpenSymbolsImage = pictogramSearch.loadOpenSymbolsImage;
    originalSearchGlobalSymbols = pictogramSearch.searchGlobalSymbolsLabels;
    app = express();
    app.use(bodyParser.json());

    swaggerTools.initializeMiddleware(
      YAML.load('./api/swagger/swagger.yaml'),
      function initialize(middleware) {
        app.use(middleware.swaggerMetadata());
        app.use(middleware.swaggerValidator());
        app.use(
          middleware.swaggerRouter({
            controllers: './test/fixtures/pictogramControllers',
            useStubs: false
          })
        );
        done();
      }
    );
  });

  after(function() {
    pictogramSearch.searchRuntimePictograms = originalSearch;
    pictogramSearch.loadArasaacImage = originalLoadImage;
    pictogramSearch.loadGlobalSymbolsImage = originalLoadGlobalSymbolsImage;
    pictogramSearch.loadOpenSymbolsImage = originalLoadOpenSymbolsImage;
    pictogramSearch.searchGlobalSymbolsLabels = originalSearchGlobalSymbols;
  });

  it('exposes the bounded missing-word search through Swagger routing', async function() {
    pictogramSearch.searchRuntimePictograms = async function search(tokens) {
      return [{ token: tokens[0], pictogram: { id: 'runtime-test' } }];
    };

    const response = await request(app)
      .post('/pictograms/search')
      .send({ tokens: ['苹果'] })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body.results[0].token).to.equal('苹果');
  });

  it('rejects unsafe proxy ids at the public contract boundary', async function() {
    await request(app)
      .get('/pictograms/arasaac/not-a-number/image')
      .expect(400);
  });

  it('returns a validated image with cache headers', async function() {
    pictogramSearch.loadArasaacImage = async function loadImage() {
      return { buffer: Buffer.from('png'), contentType: 'image/png' };
    };

    const response = await request(app)
      .get('/pictograms/arasaac/123/image')
      .expect('Content-Type', /image\/png/)
      .expect('Cache-Control', /max-age=86400/)
      .expect(200);

    expect(response.body.toString()).to.equal('png');
  });

  it('routes an HMAC-shaped OpenSymbols image token with cache headers', async function() {
    pictogramSearch.loadOpenSymbolsImage = async function loadImage() {
      return {
        buffer: Buffer.from('png'),
        contentType: 'image/png'
      };
    };
    const token = `candidate.${'a'.repeat(32)}`;

    const response = await request(app)
      .get(`/pictograms/opensymbols/${token}/image`)
      .expect('Content-Type', /image\/png/)
      .expect('Cache-Control', /max-age=86400/)
      .expect(200);

    expect(response.body.toString()).to.equal('png');
  });

  it('routes the bounded Global Symbols editor search', async function() {
    pictogramSearch.searchGlobalSymbolsLabels = async function search() {
      return [{ id: 42, text: 'apple', picto: { id: 314 } }];
    };

    const response = await request(app)
      .post('/pictograms/globalsymbols/search')
      .send({ query: 'apple', language: 'eng', limit: 5 })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body.results[0]).to.include({ id: 42, text: 'apple' });
  });

  it('routes an HMAC-shaped Global Symbols image token with cache headers', async function() {
    pictogramSearch.loadGlobalSymbolsImage = async function loadImage() {
      return { buffer: Buffer.from('png'), contentType: 'image/png' };
    };
    const token = `candidate.${'a'.repeat(32)}`;

    const response = await request(app)
      .get(`/pictograms/globalsymbols/${token}/image`)
      .expect('Content-Type', /image\/png/)
      .expect('Cache-Control', /max-age=86400/)
      .expect(200);

    expect(response.body.toString()).to.equal('png');
  });
});

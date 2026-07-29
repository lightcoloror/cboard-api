'use strict';

const chai = require('chai');

const expect = chai.expect;
const productionConfigPath = '../../config/env/production';

describe('Production configuration', function () {
  const originalMongoUrl = process.env.MONGO_URL;
  const originalSessionSecret = process.env.API_SESSION_SECRET;

  afterEach(function () {
    if (originalMongoUrl === undefined) {
      delete process.env.MONGO_URL;
    } else {
      process.env.MONGO_URL = originalMongoUrl;
    }
    if (originalSessionSecret === undefined) {
      delete process.env.API_SESSION_SECRET;
    } else {
      process.env.API_SESSION_SECRET = originalSessionSecret;
    }
    delete require.cache[require.resolve(productionConfigPath)];
  });

  it('uses deploy-time database and session secrets', function () {
    process.env.MONGO_URL =
      'mongodb://cboard:secret@mongo:27017/cboard-api?authSource=admin';
    process.env.API_SESSION_SECRET = 'session-secret-from-environment';
    delete require.cache[require.resolve(productionConfigPath)];

    const config = require(productionConfigPath);

    expect(config.databaseUrl).to.equal(process.env.MONGO_URL);
    expect(config.session.secret).to.equal(process.env.API_SESSION_SECRET);
  });

  it('does not fall back to repository-owned production secrets', function () {
    delete process.env.MONGO_URL;
    delete process.env.API_SESSION_SECRET;
    delete require.cache[require.resolve(productionConfigPath)];

    const config = require(productionConfigPath);

    expect(config.databaseUrl).to.equal(undefined);
    expect(config.session.secret).to.equal(undefined);
  });
});

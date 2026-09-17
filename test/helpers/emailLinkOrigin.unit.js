'use strict';

const chai = require('chai');
const { configuredEmailAppOrigin } = require('../../api/helpers/emailLinkOrigin');

const expect = chai.expect;

describe('configured email app origin', function() {
  it('normalizes a configured origin and ignores request headers', function() {
    expect(
      configuredEmailAppOrigin(
        { env: 'production', CBOARD_APP_URL: ' HTTPS://Tuyujia.example/app/../ ' },
        { NODE_ENV: 'production' }
      )
    ).to.equal(null);
    expect(
      configuredEmailAppOrigin(
        { env: 'production', CBOARD_APP_URL: 'https://Tuyujia.example/' },
        { NODE_ENV: 'production' }
      )
    ).to.equal('https://tuyujia.example');
  });

  it('rejects credentials, query, hash, and nested paths', function() {
    for (const value of [
      'https://user:pass@example.test',
      'https://example.test/?next=/evil',
      'https://example.test/#fragment',
      'https://example.test/activate'
    ]) {
      expect(
        configuredEmailAppOrigin({ env: 'production', CBOARD_APP_URL: value }, {})
      ).to.equal(null);
    }
  });

  it('allows explicitly configured loopback HTTP only outside production', function() {
    expect(
      configuredEmailAppOrigin(
        { env: 'test', AUTH_EMAIL_APP_URL: 'http://localhost:3000/' },
        { NODE_ENV: 'test' }
      )
    ).to.equal('http://localhost:3000');
    expect(
      configuredEmailAppOrigin(
        { env: 'test', AUTH_EMAIL_APP_URL: 'http://evil.example.test' },
        { NODE_ENV: 'test' }
      )
    ).to.equal(null);
  });

  it('requires a configured origin in production and gives the override precedence', function() {
    expect(
      configuredEmailAppOrigin({ env: 'production' }, { NODE_ENV: 'production' })
    ).to.equal(null);
    expect(
      configuredEmailAppOrigin(
        {
          env: 'production',
          CBOARD_APP_URL: 'https://configured.example.test',
          AUTH_EMAIL_APP_URL: 'https://override.example.test'
        },
        { NODE_ENV: 'production' }
      )
    ).to.equal('https://override.example.test');
  });
});

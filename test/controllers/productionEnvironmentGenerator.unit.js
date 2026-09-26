'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const chai = require('chai');
const {
  buildProductionEnvironment,
  parseArguments,
  writeExclusive
} = require('../../scripts/createProductionEnvironment');
const {
  parseEnv,
  validateProductionDeployment
} = require('../../scripts/checkProductionDeployment');
const {
  buildPrivateEnvironment
} = require('../../scripts/createPrivateEnvironment');

const expect = chai.expect;
const projectRoot = path.resolve(__dirname, '../..');

describe('Production environment generator', function() {
  it('creates unique strong core secrets without enabling optional services', function() {
    const template = fs.readFileSync(
      path.join(projectRoot, 'deploy/.env.production.example'),
      'utf8'
    );
    const values = {
      mongo: 'mongo-secret-1234567890-abcdefghijklmnopqrstuvwxyz',
      session: 'session-secret-1234567890-abcdefghijklmnopqrstuv',
      jwt: 'jwt-secret-1234567890-abcdefghijklmnopqrstuvwxyz',
      'pictogram-proxy': 'proxy-secret-1234567890-abcdefghijklmnopqrstuvwxyz'
    };
    const environment = buildProductionEnvironment({
      template,
      domain: 'api.picinterpreter.cn',
      email: 'admin@picinterpreter.cn',
      secretFactory: name => values[name]
    });
    const parsed = parseEnv(environment);

    expect(parsed.API_DOMAIN).to.equal('api.picinterpreter.cn');
    expect(parsed.ACME_EMAIL).to.equal('admin@picinterpreter.cn');
    expect(parsed.MONGO_URL).to.include(parsed.MONGO_PASSWORD);
    expect(parsed.API_SESSION_SECRET).not.to.equal(parsed.JWT_SECRET);
    expect(parsed.PHONE_VERIFICATION_REQUIRED).to.equal('false');
    expect(parsed.AZURE_STORAGE_CONNECTION_STRING).to.equal('');
  });

  it('produces a deployment configuration accepted by the production checker', function() {
    const template = fs.readFileSync(
      path.join(projectRoot, 'deploy/.env.production.example'),
      'utf8'
    );
    let counter = 0;
    const environment = buildProductionEnvironment({
      template,
      domain: 'api.picinterpreter.cn',
      email: 'admin@picinterpreter.cn',
      secretFactory: () =>
        `generated-${++counter}-secret-1234567890-abcdefghijklmnop`
    });
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'cboard-generated-production-env-')
    );
    const environmentPath = path.join(tempRoot, '.env.production');
    fs.writeFileSync(environmentPath, environment);
    try {
      expect(validateProductionDeployment({ environmentPath })).to.deep.equal(
        []
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('creates a loopback-only private environment accepted by the checker', function() {
    const template = fs.readFileSync(
      path.join(projectRoot, 'deploy/.env.production.example'),
      'utf8'
    );
    let counter = 0;
    const environment = buildPrivateEnvironment({
      template,
      secretFactory: () =>
        `private-${++counter}-secret-1234567890-abcdefghijklmnop`
    });
    const parsed = parseEnv(environment);
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'cboard-generated-private-env-')
    );
    const environmentPath = path.join(tempRoot, '.env.private');
    fs.writeFileSync(environmentPath, environment);
    try {
      expect(parsed.BIND_ADDRESS).to.equal('127.0.0.1');
      expect(parsed.HTTP_PORT).to.equal('18080');
      expect(parsed.HTTPS_PORT).to.equal('18443');
      expect(parsed.CADDYFILE).to.equal('./Caddyfile.local');
      expect(parsed.DEPLOYMENT_PROJECT_NAME).to.equal('cboard-api-private');
      expect(parsed.DEBIAN_MIRROR).to.equal(
        'http://mirrors.cloud.tencent.com/debian'
      );
      expect(parsed.DEBIAN_SECURITY_MIRROR).to.equal(
        'http://mirrors.cloud.tencent.com/debian-security'
      );
      expect(
        validateProductionDeployment({
          environmentPath,
          privateMode: true
        })
      ).to.deep.equal([]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('accepts npm-safe positional command arguments', function() {
    expect(
      parseArguments([
        'api.picinterpreter.cn',
        'admin@picinterpreter.cn',
        'deploy/custom.env'
      ])
    ).to.deep.equal({
      domain: 'api.picinterpreter.cn',
      email: 'admin@picinterpreter.cn',
      outputPath: 'deploy/custom.env'
    });
  });

  it('rejects invalid inputs, weak duplicate secrets and overwrites', function() {
    const template = fs.readFileSync(
      path.join(projectRoot, 'deploy/.env.production.example'),
      'utf8'
    );
    expect(() =>
      buildProductionEnvironment({
        template,
        domain: 'http://localhost',
        email: 'invalid',
        secretFactory: () => 'weak'
      })
    ).to.throw('Domain must be a hostname');
    expect(() =>
      buildProductionEnvironment({
        template,
        domain: 'api.picinterpreter.cn',
        email: 'admin@picinterpreter.cn',
        secretFactory: () =>
          'duplicate-secret-1234567890-abcdefghijklmnopqrstuvwxyz'
      })
    ).to.throw('unique URL-safe values');

    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'cboard-production-env-exclusive-')
    );
    const outputPath = path.join(tempRoot, '.env.production');
    try {
      writeExclusive(outputPath, 'first');
      expect(() => writeExclusive(outputPath, 'second')).to.throw();
      expect(fs.readFileSync(outputPath, 'utf8')).to.equal('first');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

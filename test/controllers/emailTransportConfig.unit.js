'use strict';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('email transport environment configuration', function() {
  let previousEmailFrom;
  let previousDevelopment;
  let previousProduction;

  beforeEach(function() {
    previousEmailFrom = process.env.EMAIL_FROM;
    previousDevelopment = require.cache[require.resolve('../../config/env/development')];
    previousProduction = require.cache[require.resolve('../../config/env/production')];
  });

  afterEach(function() {
    if (previousEmailFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousEmailFrom;
    const developmentPath = require.resolve('../../config/env/development');
    const productionPath = require.resolve('../../config/env/production');
    if (previousDevelopment) require.cache[developmentPath] = previousDevelopment;
    else delete require.cache[developmentPath];
    if (previousProduction) require.cache[productionPath] = previousProduction;
    else delete require.cache[productionPath];
    mockery.deregisterAll();
    mockery.disable();
  });

  it('requires an explicit sender and enables TLS certificate validation in development', function() {
    const previous = process.env.EMAIL_FROM;
    process.env.EMAIL_FROM = 'No Reply <noreply@example.test>';
    delete require.cache[require.resolve('../../config/env/development')];
    const config = require('../../config/env/development');
    expect(config.emailTransport.from).to.equal('No Reply <noreply@example.test>');
    expect(config.emailTransport.tls.rejectUnauthorized).to.equal(true);
    expect(config.emailTransport.port).to.equal(587);
    expect(config.emailTransport.requireTLS).to.equal(true);
  });

  it('leaves the sender empty when EMAIL_FROM is absent', function() {
    delete process.env.EMAIL_FROM;
    delete require.cache[require.resolve('../../config/env/production')];
    const config = require('../../config/env/production');
    expect(config.emailTransport.from).to.equal(undefined);
  });

  it('keeps production transport independent and certificate validated', function() {
    const previous = process.env.EMAIL_FROM;
    process.env.EMAIL_FROM = 'Production <mail@example.test>';
    delete require.cache[require.resolve('../../config/env/production')];
    const config = require('../../config/env/production');
    expect(config.emailTransport.from).to.equal('Production <mail@example.test>');
    expect(config.emailTransport.tls.rejectUnauthorized).to.equal(true);
    expect(config.emailTransport.port).to.equal(587);
    expect(config.emailTransport.requireTLS).to.equal(true);
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport(config.emailTransport);
    expect(transport.transporter.options.port).to.equal(587);
    expect(transport.transporter.options.requireTLS).to.equal(true);
    expect(transport.transporter.options.tls.rejectUnauthorized).to.equal(true);
  });

  it('injects the configured sender into all application NEV mail options', function() {
    let configured;
    mockery.enable({ warnOnReplace: false, warnOnUnregistered: false, useCleanCache: true });
    mockery.registerMock('../models/User', {});
    mockery.registerMock('./email-verification', function() {
      return {
        configure(options) { configured = options; },
        generateTempUserModel() {}
      };
    });
    mockery.registerMock('../../config', {
      emailTransport: {
        from: 'Configured Sender <mail@example.test>',
        host: 'smtp.example.test',
        auth: { user: 'apikey', pass: 'secret' }
      }
    });
    delete require.cache[require.resolve('../../api/mail/index')];
    require('../../api/mail/index');
    expect(configured.verifyMailOptions.from).to.equal('Configured Sender <mail@example.test>');
    expect(configured.confirmMailOptions.from).to.equal('Configured Sender <mail@example.test>');
    expect(configured.resetPasswordMailOptions.from).to.equal('Configured Sender <mail@example.test>');
  });
});

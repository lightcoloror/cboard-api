'use strict';

const chai = require('chai');
const {
  consumeAuthRequestLimits,
  createAuthRequestMongoLimiters,
  createAuthRequestRateLimitRuntime,
  hashRateLimitIdentity,
  normalizeEmail,
  resolveAuthRequestRateLimitConfig
} = require('../../api/helpers/authRequestRateLimit');

const expect = chai.expect;

describe('authentication request rate limits', function() {
  it('waits for unique indexes once before any concurrent consume', async function() {
    let resolveIndexes;
    const pending = new Promise(resolve => { resolveIndexes = resolve; });
    let built = 0, consumed = 0;
    const limiter = { async createIndexes() { built += 1; await pending; }, async consume() { consumed += 1; } };
    const args = { limiters: { ipHourly: limiter, emailHourly: limiter }, operation: 'closureStatus', email: 'receipt', ip: 'synthetic' };
    const requests = [consumeAuthRequestLimits(args), consumeAuthRequestLimits(args)];
    await Promise.resolve();
    expect(consumed).to.equal(0);
    resolveIndexes();
    await Promise.all(requests);
    expect(built).to.equal(1);
    expect(consumed).to.equal(4);
  });

  it('fails closed on index errors and permits a later initialization retry', async function() {
    let fail = true, consumed = 0;
    const limiter = { async createIndexes() { if (fail) throw new Error('index unavailable'); }, async consume() { consumed += 1; } };
    const args = { limiters: { ipHourly: limiter, emailHourly: limiter }, operation: 'closureStatus', email: 'receipt', ip: 'synthetic' };
    try { await consumeAuthRequestLimits(args); expect.fail('expected rejection'); }
    catch (error) { expect(error.code).to.equal('CLOSURE_STATUS_RATE_LIMIT_UNAVAILABLE'); }
    expect(consumed).to.equal(0);
    fail = false;
    await consumeAuthRequestLimits(args);
    expect(consumed).to.equal(2);
  });
  it('uses bounded independent registration and reset configuration', function() {
    const config = resolveAuthRequestRateLimitConfig({
      USER_REGISTRATION_RATE_LIMIT_EMAIL_HOURLY_LIMIT: '4',
      USER_REGISTRATION_RATE_LIMIT_IP_HOURLY_LIMIT: '31',
      PASSWORD_RESET_RATE_LIMIT_EMAIL_HOURLY_LIMIT: '5',
      PASSWORD_RESET_RATE_LIMIT_IP_HOURLY_LIMIT: '41',
      LOGIN_RATE_LIMIT_EMAIL_HOURLY_LIMIT: '21',
      LOGIN_RATE_LIMIT_IP_HOURLY_LIMIT: '101'
    });
    const configurations = [];
    class FakeLimiter {
      constructor(value) {
        configurations.push(value);
      }
    }
    createAuthRequestMongoLimiters({
      storeClient: {},
      operation: 'registration',
      config,
      RateLimiterClass: FakeLimiter
    });
    createAuthRequestMongoLimiters({
      storeClient: {},
      operation: 'passwordReset',
      config,
      RateLimiterClass: FakeLimiter
    });
    createAuthRequestMongoLimiters({
      storeClient: {},
      operation: 'login',
      config,
      RateLimiterClass: FakeLimiter
    });
    expect(configurations.map(value => value.points)).to.deep.equal([
      4,
      31,
      5,
      41,
      21,
      101
    ]);
    expect(new Set(configurations.map(value => value.tableName)).size).to.equal(
      6
    );
    expect(new Set(configurations.map(value => value.keyPrefix)).size).to.equal(
      6
    );
    const fallback = resolveAuthRequestRateLimitConfig({
      USER_REGISTRATION_RATE_LIMIT_EMAIL_HOURLY_LIMIT: '0',
      USER_REGISTRATION_RATE_LIMIT_IP_HOURLY_LIMIT: 'NaN',
      PASSWORD_RESET_RATE_LIMIT_EMAIL_HOURLY_LIMIT: '100001'
    });
    expect(fallback.registration.emailHourlyLimit).to.equal(3);
    expect(fallback.registration.ipHourlyLimit).to.equal(20);
    expect(fallback.passwordReset.emailHourlyLimit).to.equal(3);
    expect(fallback.login.emailHourlyLimit).to.equal(20);
    expect(fallback.login.ipHourlyLimit).to.equal(100);
  });

  it('hashes normalized identities and consumes IP before email', async function() {
    const keys = [];
    const limiter = {
      async consume(key, points) {
        keys.push({ key, points });
      }
    };
    await consumeAuthRequestLimits({
      limiters: { ipHourly: limiter, emailHourly: limiter },
      operation: 'registration',
      email: '  CARE@EXAMPLE.TEST ',
      ip: '203.0.113.8'
    });
    expect(keys).to.have.length(2);
    expect(keys.map(value => value.key)).to.deep.equal([
      hashRateLimitIdentity('ip:203.0.113.8'),
      hashRateLimitIdentity('email:care@example.test')
    ]);
    expect(normalizeEmail('  CARE@EXAMPLE.TEST ')).to.equal(
      'care@example.test'
    );
    keys.forEach(value => expect(value.key).to.match(/^[a-f0-9]{64}$/));
    expect(keys.every(value => value.points === 1)).to.equal(true);
  });

  it('maps limiter rejection and backend errors to stable responses', async function() {
    const rejected = {
      async consume() {
        throw { msBeforeNext: 2200 };
      }
    };
    try {
      await consumeAuthRequestLimits({
        limiters: { ipHourly: rejected, emailHourly: rejected },
        operation: 'passwordReset',
        email: 'x',
        ip: 'y'
      });
      expect.fail('expected rate limit rejection');
    } catch (error) {
      expect(error.status).to.equal(429);
      expect(error.code).to.equal('PASSWORD_RESET_RATE_LIMITED');
      expect(error.retryAfter).to.equal(3);
    }
    const broken = {
      async consume() {
        throw new Error('mongo unavailable');
      }
    };
    try {
      await consumeAuthRequestLimits({
        limiters: { ipHourly: broken, emailHourly: broken },
        operation: 'registration',
        email: 'x',
        ip: 'y'
      });
      expect.fail('expected unavailable error');
    } catch (error) {
      expect(error.status).to.equal(503);
      expect(error.code).to.equal('USER_REGISTRATION_RATE_LIMIT_UNAVAILABLE');
    }
  });

  it('counts an email rejection against the IP limiter without a refund', async function() {
    let ipConsumes = 0;
    const ipLimiter = {
      async consume() {
        ipConsumes += 1;
      }
    };
    const emailLimiter = {
      async consume() {
        throw { msBeforeNext: 1000 };
      }
    };
    try {
      await consumeAuthRequestLimits({
        limiters: { ipHourly: ipLimiter, emailHourly: emailLimiter },
        operation: 'registration',
        email: 'care@example.test',
        ip: '203.0.113.8'
      });
      expect.fail('expected email limiter rejection');
    } catch (error) {
      expect(error.code).to.equal('USER_REGISTRATION_RATE_LIMITED');
      expect(ipConsumes).to.equal(1);
    }
  });

  it('does not construct Mongo limiters until the operation is used', function() {
    let constructions = 0;
    class FakeLimiter {
      constructor() { constructions += 1; }
    }
    const runtime = createAuthRequestRateLimitRuntime({
      storeClient: {},
      RateLimiterClass: FakeLimiter
    });
    expect(constructions).to.equal(0);
    runtime.getLimiters('registration');
    expect(constructions).to.equal(2);
    runtime.getLimiters('registration');
    expect(constructions).to.equal(2);
    runtime.getLimiters('passwordReset');
    expect(constructions).to.equal(4);
    runtime.getLimiters('login');
    expect(constructions).to.equal(6);
  });
});

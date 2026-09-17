'use strict';

const chai = require('chai');
const {
  consumeEmailVerificationResendLimits,
  createEmailVerificationResendMongoLimiters,
  createEmailVerificationResendRateLimitRuntime,
  resolveEmailVerificationResendLimitConfig
} = require('../../api/helpers/emailVerificationResendRateLimit');

const expect = chai.expect;

describe('email verification resend rate limits', function() {
  it('takes deployment limits from bounded server configuration', function() {
    const config = resolveEmailVerificationResendLimitConfig({
      EMAIL_VERIFICATION_RESEND_SECONDS: '90',
      EMAIL_VERIFICATION_RESEND_EMAIL_DAILY_LIMIT: '4',
      EMAIL_VERIFICATION_RESEND_IP_HOURLY_LIMIT: '33'
    });
    const configurations = [];
    class FakeLimiter {
      constructor(configuration) {
        configurations.push(configuration);
      }
    }

    createEmailVerificationResendMongoLimiters({
      storeClient: { readyState: 1 },
      config,
      RateLimiterClass: FakeLimiter
    });

    expect(configurations.map(item => item.points)).to.deep.equal([1, 4, 33]);
    expect(configurations.map(item => item.duration)).to.deep.equal([90, 86400, 3600]);
  });

  it('uses hashed email and IP keys only', async function() {
    const keys = [];
    const limiter = {
      async consume(key) {
        keys.push(key);
      }
    };

    await consumeEmailVerificationResendLimits({
      limiters: { resend: limiter, emailDaily: limiter, ipHourly: limiter },
      email: 'care@example.test',
      ip: '203.0.113.8'
    });

    expect(keys).to.have.length(3);
    keys.forEach(key => expect(key).to.match(/^[a-f0-9]{64}$/));
    expect(keys.join(' ')).not.to.contain('care@example.test');
    expect(keys.join(' ')).not.to.contain('203.0.113.8');
  });

  it('creates Mongo limiters lazily and caches them', function() {
    let constructions = 0;
    class FakeLimiter {
      constructor() {
        constructions += 1;
      }
    }

    const runtime = createEmailVerificationResendRateLimitRuntime({
      storeClient: { readyState: 1 },
      RateLimiterClass: FakeLimiter
    });

    expect(constructions).to.equal(0);
    const first = runtime.limiters;
    expect(constructions).to.equal(3);
    expect(runtime.limiters).to.equal(first);
    expect(constructions).to.equal(3);
  });

  it('keeps injected limiters available without constructing Mongo limiters', function() {
    const injected = { resend: {}, emailDaily: {}, ipHourly: {} };
    const runtime = createEmailVerificationResendRateLimitRuntime({
      limiters: injected,
      RateLimiterClass: class UnexpectedLimiter {
        constructor() {
          throw new Error('injected limiters should bypass Mongo construction');
        }
      }
    });

    expect(runtime.limiters).to.equal(injected);
  });
});

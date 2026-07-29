'use strict';

const chai = require('chai');
const {
  IP_HOURLY_LIMIT,
  PHONE_DAILY_LIMIT,
  RESEND_SECONDS,
  consumePhoneVerificationSendLimits,
  createPhoneVerificationMongoLimiters
} = require('../../api/helpers/phoneVerificationRateLimit');

const expect = chai.expect;

describe('Phone verification rate limits', function() {
  it('reuses rate-limiter-flexible with phone, resend and IP scopes', function() {
    const configurations = [];
    class FakeLimiter {
      constructor(configuration) {
        configurations.push(configuration);
      }
    }

    createPhoneVerificationMongoLimiters({
      storeClient: { readyState: 1 },
      RateLimiterClass: FakeLimiter
    });

    expect(configurations.map(item => item.points)).to.deep.equal([
      1,
      PHONE_DAILY_LIMIT,
      IP_HOURLY_LIMIT
    ]);
    expect(configurations.map(item => item.duration)).to.deep.equal([
      RESEND_SECONDS,
      86400,
      3600
    ]);
  });

  it('never exposes the raw phone or IP as limiter keys', async function() {
    const keys = [];
    const limiter = {
      async consume(key) {
        keys.push(key);
        return { remainingPoints: 1 };
      }
    };

    await consumePhoneVerificationSendLimits({
      limiters: {
        resend: limiter,
        phoneDaily: limiter,
        ipHourly: limiter
      },
      phone: '13800138000',
      ip: '203.0.113.8'
    });

    expect(keys).to.have.length(3);
    keys.forEach(key => expect(key).to.match(/^[a-f0-9]{64}$/));
    expect(keys.join(' ')).not.to.contain('13800138000');
    expect(keys.join(' ')).not.to.contain('203.0.113.8');
  });

  it('returns a bounded retry time for a mature limiter rejection', async function() {
    const allowed = { consume: async function() {} };
    let caught;
    try {
      await consumePhoneVerificationSendLimits({
        limiters: {
          ipHourly: allowed,
          phoneDaily: allowed,
          resend: {
            async consume() {
              throw { msBeforeNext: 1500 };
            }
          }
        },
        phone: '13800138000',
        ip: '203.0.113.8'
      });
    } catch (error) {
      caught = error;
    }

    expect(caught.status).to.equal(429);
    expect(caught.retryAfter).to.equal(2);
    expect(caught.code).to.equal('PHONE_VERIFICATION_RATE_LIMITED');
  });
});

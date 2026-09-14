'use strict';

const assert = require('assert').strict;
const { consumeCareTrialLimits, createCareTrialMongoLimiters, resolveCareTrialLimitConfig } = require('../../api/helpers/careTrialRateLimit');

describe('care trial rate limits', function() {
  it('uses bounded server configuration and hashed account/IP keys', async function() {
    const config = resolveCareTrialLimitConfig({ CARE_TRIAL_ACCOUNT_HOURLY_LIMIT: '4', CARE_TRIAL_IP_HOURLY_LIMIT: '9' });
    const configs = []; class FakeLimiter { constructor(value) { configs.push(value); } }
    createCareTrialMongoLimiters({ storeClient: { readyState: 1 }, config, RateLimiterClass: FakeLimiter });
    assert.deepEqual(configs.map(value => value.points), [4, 9]);
    const keys = []; const limiter = { consume: async key => keys.push(key) };
    await consumeCareTrialLimits({ limiters: { accountHourly: limiter, ipHourly: limiter }, accountId: 'user-a', ip: '203.0.113.8' });
    assert.equal(keys.length, 2); keys.forEach(key => assert.match(key, /^[a-f0-9]{64}$/));
  });

  it('returns a stable 429 for limiter rejection and fails closed for store errors', async function() {
    const rejected = { consume: async () => { throw { msBeforeNext: 2000 }; } };
    await assert.rejects(consumeCareTrialLimits({ limiters: { accountHourly: rejected, ipHourly: rejected }, accountId: 'user-a', ip: '203.0.113.8' }), error => error.status === 429 && error.code === 'CARE_TRIAL_RATE_LIMITED' && error.retryAfter === 2);
    const broken = { consume: async () => { throw new Error('synthetic mongo unavailable'); } };
    await assert.rejects(consumeCareTrialLimits({ limiters: { accountHourly: broken, ipHourly: broken }, accountId: 'user-a', ip: '203.0.113.8' }), error => error.status === 503 && error.code === 'CARE_TRIAL_RATE_LIMIT_UNAVAILABLE');
  });
});

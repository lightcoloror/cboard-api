'use strict';

const chai = require('chai');
const {
  OPERATION_COSTS,
  buildMonthlyRateLimitKey,
  createCommunicationEnhancementMongoLimiters,
  createCommunicationEnhancementRateLimitMiddleware,
  hashRateLimitIdentity,
  resolveCommunicationEnhancementRateLimitConfig
} = require('../../api/helpers/communicationEnhancementRateLimit');

const expect = chai.expect;

function createResponseHarness() {
  const value = {
    statusCode: 0,
    body: null,
    headers: {}
  };
  return {
    value,
    response: {
      set(name, content) {
        value.headers[name] = content;
        return this;
      },
      status(statusCode) {
        value.statusCode = statusCode;
        return this;
      },
      json(body) {
        value.body = body;
        return body;
      }
    }
  };
}

function createRequest(operationId, userId = 'user-1') {
  return {
    swagger: { operation: { operationId } },
    user: userId ? { id: userId } : null
  };
}

describe('Communication enhancement rate limit', function() {
  it('does not apply the old monthly cap when weekly funding is enabled', async function() {
    const calls = [];
    const middleware = createCommunicationEnhancementRateLimitMiddleware({
      env: { CARE_NEXT_ENABLED: 'true' }, config: { enabled: true, pointsPerMinute: 20, monthlyPoints: 1 },
      limiters: { minute: { consume: async () => { calls.push('minute'); return {}; } }, monthly: { consume: async () => { throw new Error('Old monthly billing must not execute'); } } }
    });
    const harness = createResponseHarness();
    await middleware(createRequest('generateCommunicationSentences'), harness.response, () => calls.push('next'));
    expect(calls).to.deep.equal(['minute', 'next']);
  });
  it('enables safe defaults in production and stays off in development', function() {
    expect(
      resolveCommunicationEnhancementRateLimitConfig({}, 'production')
    ).to.deep.equal({
      enabled: true,
      pointsPerMinute: 30,
      monthlyPoints: 1000
    });
    expect(
      resolveCommunicationEnhancementRateLimitConfig({}, 'development')
        .enabled
    ).to.equal(false);
  });

  it('accepts only bounded explicit production settings', function() {
    expect(
      resolveCommunicationEnhancementRateLimitConfig(
        {
          COMMUNICATION_ENHANCEMENT_RATE_LIMIT_ENABLED: 'true',
          COMMUNICATION_ENHANCEMENT_POINTS_PER_MINUTE: '45',
          COMMUNICATION_ENHANCEMENT_MONTHLY_POINTS: '2500'
        },
        'development'
      )
    ).to.deep.equal({
      enabled: true,
      pointsPerMinute: 45,
      monthlyPoints: 2500
    });
    expect(
      resolveCommunicationEnhancementRateLimitConfig(
        {
          COMMUNICATION_ENHANCEMENT_POINTS_PER_MINUTE: '0',
          COMMUNICATION_ENHANCEMENT_MONTHLY_POINTS: 'invalid'
        },
        'production'
      )
    ).to.include({
      pointsPerMinute: 30,
      monthlyPoints: 1000
    });
  });

  it('builds Mongo limiters through the reused library configuration', function() {
    const calls = [];
    class FakeRateLimiter {
      constructor(options) {
        calls.push(options);
      }
    }
    const connection = {};

    createCommunicationEnhancementMongoLimiters({
      storeClient: connection,
      config: { pointsPerMinute: 12, monthlyPoints: 345 },
      RateLimiterClass: FakeRateLimiter
    });

    expect(calls).to.have.length(2);
    expect(calls[0]).to.include({
      storeClient: connection,
      points: 12,
      duration: 60,
      tableName: 'communicationEnhancementMinuteLimits'
    });
    expect(calls[1]).to.include({
      storeClient: connection,
      points: 345,
      tableName: 'communicationEnhancementMonthlyLimits'
    });
  });

  it('uses weighted costs, a hashed user key, and a calendar-month key', async function() {
    const calls = [];
    const limiters = {
      minute: {
        consume: async (key, points) => {
          calls.push({ scope: 'minute', key, points });
          return { remainingPoints: 18, msBeforeNext: 1000 };
        }
      },
      monthly: {
        consume: async (key, points) => {
          calls.push({ scope: 'month', key, points });
          return { remainingPoints: 980, msBeforeNext: 1000 };
        }
      }
    };
    const middleware = createCommunicationEnhancementRateLimitMiddleware({
      config: { enabled: true, pointsPerMinute: 20, monthlyPoints: 1000 },
      limiters,
      now: () => new Date('2026-07-22T00:00:00Z')
    });
    const harness = createResponseHarness();
    let nextCalled = false;

    await middleware(
      createRequest('recognizeCommunicationImageText'),
      harness.response,
      () => {
        nextCalled = true;
      }
    );

    const identityHash = hashRateLimitIdentity('user-1');
    expect(calls).to.deep.equal([
      {
        scope: 'minute',
        key: identityHash,
        points: OPERATION_COSTS.recognizeCommunicationImageText
      },
      {
        scope: 'month',
        key: buildMonthlyRateLimitKey(
          identityHash,
          new Date('2026-07-22T00:00:00Z')
        ),
        points: OPERATION_COSTS.recognizeCommunicationImageText
      }
    ]);
    expect(calls[0].key).not.to.include('user-1');
    expect(harness.value.headers).to.include({
      'RateLimit-Limit': '20',
      'RateLimit-Remaining': '18',
      'X-Monthly-Quota-Limit': '1000',
      'X-Monthly-Quota-Remaining': '980'
    });
    expect(nextCalled).to.equal(true);
    expect(OPERATION_COSTS.generateCommunicationPictogram).to.equal(8);
  });

  it('does not consume quota for health or unrelated operations', async function() {
    let consumeCount = 0;
    const limiter = {
      consume: async () => {
        consumeCount += 1;
      }
    };
    const middleware = createCommunicationEnhancementRateLimitMiddleware({
      config: { enabled: true, pointsPerMinute: 20, monthlyPoints: 1000 },
      limiters: { minute: limiter, monthly: limiter }
    });
    const harness = createResponseHarness();
    let nextCount = 0;

    await middleware(
      createRequest('getCommunicationAiHealth'),
      harness.response,
      () => {
        nextCount += 1;
      }
    );
    await middleware(
      createRequest('getSettings'),
      harness.response,
      () => {
        nextCount += 1;
      }
    );

    expect(consumeCount).to.equal(0);
    expect(nextCount).to.equal(2);
  });

  it('returns a bounded retry response when the minute limit is exceeded', async function() {
    const middleware = createCommunicationEnhancementRateLimitMiddleware({
      config: { enabled: true, pointsPerMinute: 20, monthlyPoints: 1000 },
      limiters: {
        minute: {
          consume: async () =>
            Promise.reject({ msBeforeNext: 1500, remainingPoints: 0 })
        },
        monthly: { consume: async () => ({ remainingPoints: 999 }) }
      }
    });
    const harness = createResponseHarness();

    await middleware(
      createRequest('generateCommunicationSentences'),
      harness.response,
      () => {}
    );

    expect(harness.value.statusCode).to.equal(429);
    expect(harness.value.headers['Retry-After']).to.equal('2');
    expect(harness.value.headers['X-RateLimit-Scope']).to.equal('minute');
    expect(harness.value.headers['RateLimit-Limit']).to.equal('20');
    expect(harness.value.headers['RateLimit-Remaining']).to.equal('0');
    expect(harness.value.body.error.code).to.equal(
      'COMMUNICATION_RATE_LIMITED'
    );
  });

  it('returns a separate monthly quota response', async function() {
    const middleware = createCommunicationEnhancementRateLimitMiddleware({
      config: { enabled: true, pointsPerMinute: 20, monthlyPoints: 1000 },
      now: () => new Date('2026-07-22T00:00:00Z'),
      limiters: {
        minute: { consume: async () => ({ remainingPoints: 19 }) },
        monthly: {
          consume: async () =>
            Promise.reject({ msBeforeNext: 86400000, remainingPoints: 0 })
        }
      }
    });
    const harness = createResponseHarness();

    await middleware(
      createRequest('synthesizeCommunicationSpeech'),
      harness.response,
      () => {}
    );

    expect(harness.value.statusCode).to.equal(429);
    expect(harness.value.headers['Retry-After']).to.equal('864000');
    expect(harness.value.headers['X-RateLimit-Scope']).to.equal('month');
    expect(harness.value.headers['X-Monthly-Quota-Limit']).to.equal('1000');
    expect(harness.value.headers['X-Monthly-Quota-Remaining']).to.equal('0');
    expect(harness.value.body.error.code).to.equal(
      'COMMUNICATION_MONTHLY_QUOTA_EXCEEDED'
    );
  });

  it('fails closed without leaking a Mongo error', async function() {
    const middleware = createCommunicationEnhancementRateLimitMiddleware({
      config: { enabled: true, pointsPerMinute: 20, monthlyPoints: 1000 },
      limiters: {
        minute: {
          consume: async () => {
            throw new Error('mongodb://private-host/secret');
          }
        },
        monthly: { consume: async () => ({ remainingPoints: 999 }) }
      }
    });
    const harness = createResponseHarness();

    await middleware(
      createRequest('resegmentCommunicationText'),
      harness.response,
      () => {}
    );

    expect(harness.value.statusCode).to.equal(503);
    expect(JSON.stringify(harness.value.body)).not.to.include('private-host');
    expect(harness.value.body.error.code).to.equal(
      'COMMUNICATION_RATE_LIMIT_UNAVAILABLE'
    );
  });
});

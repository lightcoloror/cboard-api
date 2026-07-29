'use strict';

const chai = require('chai');
const {
  createCommunicationAiTokenQuotaMiddleware,
  createCommunicationAiTokenQuotaService,
  getRequestTokenReservation,
  resolveCommunicationAiTokenQuotaConfig
} = require('../../api/helpers/communicationAiTokenQuota');

const expect = chai.expect;

function createLimiter(overrides = {}) {
  const calls = [];
  return {
    calls,
    async consume(...args) {
      calls.push(['consume', ...args]);
      if (overrides.consume) return overrides.consume(...args);
      return { consumedPoints: args[1], remainingPoints: 1000000 - args[1] };
    },
    async reward(...args) {
      calls.push(['reward', ...args]);
      if (overrides.reward) return overrides.reward(...args);
      return { consumedPoints: 0, remainingPoints: 1000000 };
    },
    async penalty(...args) {
      calls.push(['penalty', ...args]);
      if (overrides.penalty) return overrides.penalty(...args);
      return { consumedPoints: args[1], remainingPoints: 0 };
    },
    async get(...args) {
      calls.push(['get', ...args]);
      if (overrides.get) return overrides.get(...args);
      return null;
    },
    async delete(...args) {
      calls.push(['delete', ...args]);
      if (overrides.delete) return overrides.delete(...args);
      return true;
    }
  };
}

function createRequest(operationId = 'generateCommunicationSentences') {
  return {
    user: { id: '507f1f77bcf86cd799439011' },
    swagger: { operation: { operationId } }
  };
}

describe('Communication AI monthly token quota', function() {
  const config = Object.freeze({
    enabled: true,
    monthlyTokens: 1000000,
    textReservationTokens: 4096,
    imageReservationTokens: 32768
  });

  it('is production-on by default and bounds configurable reservations', function() {
    expect(
      resolveCommunicationAiTokenQuotaConfig({}, 'development').enabled
    ).to.equal(false);
    expect(
      resolveCommunicationAiTokenQuotaConfig({}, 'production')
    ).to.deep.equal(config);
    expect(
      resolveCommunicationAiTokenQuotaConfig(
        {
          COMMUNICATION_AI_TOKEN_QUOTA_ENABLED: 'true',
          COMMUNICATION_AI_MONTHLY_TOKEN_QUOTA: '2000',
          COMMUNICATION_AI_TEXT_TOKEN_RESERVATION: '500',
          COMMUNICATION_AI_IMAGE_TOKEN_RESERVATION: '9000'
        },
        'test'
      )
    ).to.deep.equal({
      enabled: true,
      monthlyTokens: 2000,
      textReservationTokens: 500,
      imageReservationTokens: 2000
    });
  });

  it('reserves text and image operations without charging other providers', function() {
    expect(
      getRequestTokenReservation(
        createRequest('generateCommunicationSentences'),
        config
      )
    ).to.equal(4096);
    expect(
      getRequestTokenReservation(
        createRequest('recognizeCommunicationImageText'),
        config
      )
    ).to.equal(32768);
    expect(
      getRequestTokenReservation(
        createRequest('generateCommunicationPictogram'),
        config
      )
    ).to.equal(32768);
    expect(
      getRequestTokenReservation(
        createRequest('synthesizeCommunicationSpeech'),
        config
      )
    ).to.equal(0);
  });

  it('atomically reserves by hashed user and natural UTC month', async function() {
    const limiter = createLimiter();
    const service = createCommunicationAiTokenQuotaService({
      config,
      limiter,
      now: () => new Date('2026-07-22T01:02:03.000Z')
    });

    const reservation = await service.reserve({
      userId: 'patient-user-id',
      operationId: 'resegmentCommunicationText'
    });

    expect(reservation).to.include({
      month: '2026-07',
      tokens: 4096,
      state: 'reserved'
    });
    expect(limiter.calls[0][0]).to.equal('consume');
    expect(limiter.calls[0][1]).to.match(/^2026-07:[a-f0-9]{64}$/);
    expect(limiter.calls[0][1]).not.to.include('patient-user-id');
    expect(limiter.calls[0][2]).to.equal(4096);
    expect(limiter.calls[0][3].customDuration).to.be.greaterThan(1);
  });

  it('refunds the increment from a rejected atomic reservation', async function() {
    const limiter = createLimiter({
      async consume() {
        throw {
          consumedPoints: 1004096,
          msBeforeNext: 60,
          remainingPoints: 0
        };
      }
    });
    const service = createCommunicationAiTokenQuotaService({
      config,
      limiter,
      now: () => new Date('2026-07-22T01:02:03.000Z')
    });

    let quotaError;
    try {
      await service.reserve({
        userId: 'user-id',
        operationId: 'generateCommunicationSentences'
      });
    } catch (error) {
      quotaError = error;
    }

    expect(quotaError).to.include({
      code: 'COMMUNICATION_AI_TOKEN_QUOTA_EXCEEDED',
      status: 429
    });
    expect(limiter.calls[1][0]).to.equal('reward');
    expect(limiter.calls[1][1]).to.equal(limiter.calls[0][1]);
    expect(limiter.calls[1][2]).to.equal(4096);
  });

  it('fails closed when a rejected reservation cannot be refunded', async function() {
    const limiter = createLimiter({
      async consume() {
        throw {
          consumedPoints: 1004096,
          msBeforeNext: 60,
          remainingPoints: 0
        };
      },
      async reward() {
        throw new Error('mongo unavailable');
      }
    });
    const service = createCommunicationAiTokenQuotaService({
      config,
      limiter
    });

    let quotaError;
    try {
      await service.reserve({
        userId: 'user-id',
        operationId: 'generateCommunicationSentences'
      });
    } catch (error) {
      quotaError = error;
    }

    expect(quotaError).to.include({
      code: 'COMMUNICATION_AI_TOKEN_QUOTA_UNAVAILABLE',
      status: 503
    });
    expect(limiter.calls.map(call => call[0])).to.deep.equal([
      'consume',
      'reward'
    ]);
  });

  it('refunds the unused reservation after provider-reported usage', async function() {
    const limiter = createLimiter();
    const service = createCommunicationAiTokenQuotaService({
      config,
      limiter,
      now: () => new Date('2026-07-22T01:02:03.000Z')
    });
    const reservation = await service.reserve({
      userId: 'user-id',
      operationId: 'generateCommunicationSentences'
    });

    const result = await service.settleReservation(reservation, {
      prompt_tokens: 500,
      completion_tokens: 100,
      total_tokens: 600
    });

    expect(result).to.deep.equal({
      actualTokens: 600,
      providerReported: true
    });
    expect(limiter.calls[1]).to.deep.equal(['reward', reservation.key, 3496]);
    expect(reservation.state).to.equal('settled');
  });

  it('keeps the conservative reservation when a provider omits usage', async function() {
    const limiter = createLimiter();
    const service = createCommunicationAiTokenQuotaService({
      config,
      limiter
    });
    const reservation = await service.reserve({
      userId: 'user-id',
      operationId: 'resegmentCommunicationText'
    });

    const result = await service.settleReservation(reservation, null);

    expect(result).to.deep.equal({
      actualTokens: 4096,
      providerReported: false
    });
    expect(limiter.calls).to.have.length(1);
  });

  it('accounts for a provider total above the reservation', async function() {
    const limiter = createLimiter();
    const service = createCommunicationAiTokenQuotaService({
      config,
      limiter
    });
    const reservation = await service.reserve({
      userId: 'user-id',
      operationId: 'editPhrase'
    });

    await service.settleReservation(reservation, {
      total_tokens: 5000
    });

    expect(limiter.calls[1]).to.deep.equal(['penalty', reservation.key, 904]);
  });

  it('releases the full reservation after validation or provider failure', async function() {
    const limiter = createLimiter();
    const service = createCommunicationAiTokenQuotaService({
      config,
      limiter
    });
    const reservation = await service.reserve({
      userId: 'user-id',
      operationId: 'editPhrase'
    });

    expect(await service.releaseReservation(reservation)).to.equal(true);
    expect(await service.releaseReservation(reservation)).to.equal(false);
    expect(limiter.calls[1]).to.deep.equal(['reward', reservation.key, 4096]);
  });

  it('returns a content-free current-month quota status', async function() {
    const limiter = createLimiter({
      get: async () => ({
        consumedPoints: 12345,
        remainingPoints: 987655
      })
    });
    const service = createCommunicationAiTokenQuotaService({
      config,
      limiter,
      now: () => new Date('2026-07-31T23:59:59.000Z')
    });

    expect(await service.getStatus({ userId: 'user-id' })).to.deep.equal({
      enabled: true,
      month: '2026-07',
      limitTokens: 1000000,
      consumedTokens: 12345,
      remainingTokens: 987655,
      resetAt: '2026-08-01T00:00:00.000Z'
    });
  });

  it('deletes the current hashed monthly key during account deletion', async function() {
    const limiter = createLimiter();
    const service = createCommunicationAiTokenQuotaService({
      config,
      limiter,
      now: () => new Date('2026-07-22T01:02:03.000Z')
    });

    expect(
      await service.deleteUserQuota({ userId: 'patient-user-id' })
    ).to.equal(true);
    expect(limiter.calls[0][0]).to.equal('delete');
    expect(limiter.calls[0][1]).to.match(/^2026-07:[a-f0-9]{64}$/);
    expect(limiter.calls[0][1]).not.to.include('patient-user-id');
  });

  it('rejects before the provider and exposes only bounded quota metadata', async function() {
    const service = {
      reserve: async () => {
        throw Object.assign(
          new Error('Monthly communication AI token quota exceeded'),
          {
            code: 'COMMUNICATION_AI_TOKEN_QUOTA_EXCEEDED',
            status: 429,
            retryAfter: 60
          }
        );
      }
    };
    const middleware = createCommunicationAiTokenQuotaMiddleware({
      config,
      service
    });
    const value = { headers: {}, status: 0, body: null, next: 0 };
    const response = {
      set(name, content) {
        value.headers[name] = content;
        return this;
      },
      status(status) {
        value.status = status;
        return this;
      },
      json(body) {
        value.body = body;
        return body;
      }
    };

    await middleware(createRequest(), response, () => {
      value.next += 1;
    });

    expect(value.next).to.equal(0);
    expect(value.status).to.equal(429);
    expect(value.headers).to.include({
      'Retry-After': '60',
      'X-RateLimit-Scope': 'ai-token-month',
      'X-AI-Token-Quota-Limit': '1000000',
      'X-AI-Token-Quota-Remaining': '0'
    });
    expect(value.body).to.deep.equal({
      error: {
        code: 'COMMUNICATION_AI_TOKEN_QUOTA_EXCEEDED',
        message: 'Monthly communication AI token quota exceeded'
      }
    });
  });

  it('releases an unused reservation when the request finishes without usage', async function() {
    const reservation = {
      tokens: 4096,
      remainingTokens: 995904
    };
    let released = 0;
    const service = {
      reserve: async () => reservation,
      releaseReservation: async value => {
        expect(value).to.equal(reservation);
        released += 1;
      }
    };
    const middleware = createCommunicationAiTokenQuotaMiddleware({
      config,
      service
    });
    const listeners = {};
    const response = {
      set() {
        return this;
      },
      once(name, listener) {
        listeners[name] = listener;
        return this;
      }
    };
    let nextCalled = 0;

    await middleware(createRequest(), response, () => {
      nextCalled += 1;
    });
    listeners.finish();
    await Promise.resolve();

    expect(nextCalled).to.equal(1);
    expect(released).to.equal(1);
  });
});

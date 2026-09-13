'use strict';

const { RateLimiterMongo } = require('rate-limiter-flexible');
const {
  getUtcMonth,
  normalizeCommunicationAiUsage
} = require('./communicationAiUsage');
const {
  buildMonthlyRateLimitKey,
  hashRateLimitIdentity,
  millisecondsUntilNextUtcMonth
} = require('./communicationEnhancementRateLimit');

const DEFAULT_MONTHLY_TOKEN_QUOTA = 1000000;
const DEFAULT_TEXT_TOKEN_RESERVATION = 4096;
const DEFAULT_IMAGE_TOKEN_RESERVATION = 32768;
const MAX_MONTHLY_TOKEN_QUOTA = 1000000000;
const MONTH_RETENTION_SECONDS = 32 * 24 * 60 * 60;
const AI_TOKEN_OPERATION_KINDS = Object.freeze({
  editPhrase: 'text',
  generateCommunicationSentences: 'text',
  normalizeCommunicationDialectText: 'text',
  recognizeCommunicationImageText: 'image',
  resegmentCommunicationText: 'text',
  suggestCommunicationPictogramMetadata: 'image',
  generateCommunicationPictogram: 'image'
});

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function resolveCommunicationAiTokenQuotaConfig(
  env = process.env,
  environment = process.env.NODE_ENV
) {
  const setting = String(env.COMMUNICATION_AI_TOKEN_QUOTA_ENABLED || '')
    .trim()
    .toLowerCase();
  const enabled =
    setting === 'true' ||
    (!setting && String(environment || '').toLowerCase() === 'production');
  const monthlyTokens = boundedInteger(
    env.COMMUNICATION_AI_MONTHLY_TOKEN_QUOTA,
    DEFAULT_MONTHLY_TOKEN_QUOTA,
    1,
    MAX_MONTHLY_TOKEN_QUOTA
  );

  return Object.freeze({
    enabled,
    monthlyTokens,
    textReservationTokens: Math.min(
      monthlyTokens,
      boundedInteger(
        env.COMMUNICATION_AI_TEXT_TOKEN_RESERVATION,
        DEFAULT_TEXT_TOKEN_RESERVATION,
        1,
        MAX_MONTHLY_TOKEN_QUOTA
      )
    ),
    imageReservationTokens: Math.min(
      monthlyTokens,
      boundedInteger(
        env.COMMUNICATION_AI_IMAGE_TOKEN_RESERVATION,
        DEFAULT_IMAGE_TOKEN_RESERVATION,
        1,
        MAX_MONTHLY_TOKEN_QUOTA
      )
    )
  });
}

function getSwaggerOperationId(req) {
  return String(
    (req &&
      req.swagger &&
      req.swagger.operation &&
      req.swagger.operation.operationId) ||
      ''
  ).trim();
}

function getRequestTokenReservation(req, config) {
  const kind = AI_TOKEN_OPERATION_KINDS[getSwaggerOperationId(req)];
  if (kind === 'image') return config.imageReservationTokens;
  if (kind === 'text') return config.textReservationTokens;
  return 0;
}

function getNextUtcMonth(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function secondsUntilNextUtcMonth(value = new Date()) {
  return Math.max(1, Math.ceil(millisecondsUntilNextUtcMonth(value) / 1000));
}

function isRateLimitRejection(value) {
  return Boolean(
    value &&
      !(value instanceof Error) &&
      Number.isFinite(Number(value.msBeforeNext))
  );
}

function createTokenQuotaError(code, message, status, retryAfter) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (retryAfter) error.retryAfter = retryAfter;
  return error;
}

function createCommunicationAiTokenQuotaLimiter({
  storeClient,
  config,
  RateLimiterClass = RateLimiterMongo
}) {
  if (!storeClient) {
    throw new TypeError('Mongo connection is required for AI token quota');
  }
  return new RateLimiterClass({
    storeClient,
    keyPrefix: 'communication_ai_token_month',
    tableName: 'communicationAiMonthlyTokenQuotas',
    points: config.monthlyTokens,
    duration: MONTH_RETENTION_SECONDS
  });
}

function createQuotaSnapshot(config, now, consumedTokens = 0) {
  const normalizedConsumed = Math.max(
    0,
    Math.min(
      Number.MAX_SAFE_INTEGER,
      Number.isFinite(Number(consumedTokens))
        ? Math.floor(Number(consumedTokens))
        : 0
    )
  );
  return {
    enabled: config.enabled,
    month: getUtcMonth(now),
    limitTokens: config.monthlyTokens,
    consumedTokens: normalizedConsumed,
    remainingTokens: Math.max(0, config.monthlyTokens - normalizedConsumed),
    resetAt: getNextUtcMonth(now).toISOString()
  };
}

function runReservationExclusive(reservation, operation) {
  const pending = reservation.pending.then(operation, operation);
  reservation.pending = pending.catch(() => {});
  return pending;
}

function createCommunicationAiTokenQuotaService({
  config = resolveCommunicationAiTokenQuotaConfig(),
  limiter,
  storeClient,
  RateLimiterClass,
  now = () => new Date()
} = {}) {
  const quotaLimiter = config.enabled
    ? limiter ||
      createCommunicationAiTokenQuotaLimiter({
        storeClient,
        config,
        RateLimiterClass
      })
    : null;

  function createKey(userId, date) {
    return buildMonthlyRateLimitKey(hashRateLimitIdentity(userId), date);
  }

  async function reserve({ userId, operationId }) {
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedUserId) {
      throw new TypeError('AI token quota requires a user');
    }
    const request = {
      swagger: { operation: { operationId } }
    };
    const reservationTokens = getRequestTokenReservation(request, config);
    if (!config.enabled || !reservationTokens) return null;

    const reservedAt = now();
    const key = createKey(normalizedUserId, reservedAt);
    let result;
    try {
      result = await quotaLimiter.consume(key, reservationTokens, {
        customDuration: secondsUntilNextUtcMonth(reservedAt)
      });
    } catch (error) {
      if (isRateLimitRejection(error)) {
        try {
          await quotaLimiter.reward(key, reservationTokens);
        } catch (refundError) {
          throw createTokenQuotaError(
            'COMMUNICATION_AI_TOKEN_QUOTA_UNAVAILABLE',
            'Communication AI token quota is temporarily unavailable',
            503
          );
        }
        throw createTokenQuotaError(
          'COMMUNICATION_AI_TOKEN_QUOTA_EXCEEDED',
          'Monthly communication AI token quota exceeded',
          429,
          secondsUntilNextUtcMonth(reservedAt)
        );
      }
      throw createTokenQuotaError(
        'COMMUNICATION_AI_TOKEN_QUOTA_UNAVAILABLE',
        'Communication AI token quota is temporarily unavailable',
        503
      );
    }

    return {
      key,
      month: getUtcMonth(reservedAt),
      tokens: reservationTokens,
      remainingTokens: Math.max(
        0,
        Number(result && result.remainingPoints) || 0
      ),
      state: 'reserved',
      pending: Promise.resolve()
    };
  }

  async function settleReservation(reservation, usage) {
    if (!reservation) return null;
    return runReservationExclusive(reservation, async () => {
      if (reservation.state !== 'reserved') return null;
      reservation.state = 'settling';
      const normalizedUsage = normalizeCommunicationAiUsage(usage);
      const actualTokens = normalizedUsage.reported
        ? normalizedUsage.totalTokens
        : reservation.tokens;
      const difference = reservation.tokens - actualTokens;

      try {
        if (difference > 0) {
          await quotaLimiter.reward(reservation.key, difference);
        } else if (difference < 0) {
          await quotaLimiter.penalty(reservation.key, -difference);
        }
        reservation.state = 'settled';
        reservation.actualTokens = actualTokens;
        reservation.providerReported = normalizedUsage.reported;
        return {
          actualTokens,
          providerReported: normalizedUsage.reported
        };
      } catch (error) {
        reservation.state = 'reserved';
        throw createTokenQuotaError(
          'COMMUNICATION_AI_TOKEN_QUOTA_UNAVAILABLE',
          'Communication AI token quota is temporarily unavailable',
          503
        );
      }
    });
  }

  async function releaseReservation(reservation) {
    if (!reservation) return false;
    return runReservationExclusive(reservation, async () => {
      if (reservation.state !== 'reserved') return false;
      reservation.state = 'releasing';
      try {
        await quotaLimiter.reward(reservation.key, reservation.tokens);
        reservation.state = 'released';
        return true;
      } catch (error) {
        reservation.state = 'reserved';
        throw createTokenQuotaError(
          'COMMUNICATION_AI_TOKEN_QUOTA_UNAVAILABLE',
          'Communication AI token quota is temporarily unavailable',
          503
        );
      }
    });
  }

  async function getStatus({ userId }) {
    const statusAt = now();
    if (!config.enabled) return createQuotaSnapshot(config, statusAt);
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedUserId) {
      throw new TypeError('AI token quota requires a user');
    }

    try {
      const result = await quotaLimiter.get(
        createKey(normalizedUserId, statusAt)
      );
      return createQuotaSnapshot(
        config,
        statusAt,
        result && result.consumedPoints
      );
    } catch (error) {
      throw createTokenQuotaError(
        'COMMUNICATION_AI_TOKEN_QUOTA_UNAVAILABLE',
        'Communication AI token quota is temporarily unavailable',
        503
      );
    }
  }

  async function deleteUserQuota({ userId }) {
    if (!config.enabled) return false;
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedUserId) {
      throw new TypeError('AI token quota requires a user');
    }
    try {
      return Boolean(
        await quotaLimiter.delete(createKey(normalizedUserId, now()))
      );
    } catch (error) {
      throw createTokenQuotaError(
        'COMMUNICATION_AI_TOKEN_QUOTA_UNAVAILABLE',
        'Communication AI token quota is temporarily unavailable',
        503
      );
    }
  }

  return {
    config,
    deleteUserQuota,
    getStatus,
    releaseReservation,
    reserve,
    settleReservation
  };
}

function sendQuotaError(res, error, config) {
  if (error.retryAfter) {
    res.set('Retry-After', String(error.retryAfter));
  }
  res.set('X-RateLimit-Scope', 'ai-token-month');
  res.set('X-AI-Token-Quota-Limit', String(config.monthlyTokens));
  if (error.status === 429) {
    res.set('X-AI-Token-Quota-Remaining', '0');
  }
  return res.status(error.status || 503).json({
    error: {
      code: error.code || 'COMMUNICATION_AI_TOKEN_QUOTA_UNAVAILABLE',
      message: error.message
    }
  });
}

function createCommunicationAiTokenQuotaMiddleware(options = {}) {
  const config =
    options.config ||
    resolveCommunicationAiTokenQuotaConfig(options.env, options.environment);
  const service =
    options.service ||
    createCommunicationAiTokenQuotaService({
      config,
      limiter: options.limiter,
      storeClient: options.storeClient,
      RateLimiterClass: options.RateLimiterClass,
      now: options.now
    });

  const middleware = async function communicationAiTokenQuota(req, res, next) {
    if (req.careUsage) return next();
    req.communicationAiTokenQuotaService = service;
    const reservationTokens = getRequestTokenReservation(req, config);
    if (!config.enabled || !reservationTokens) return next();

    const userId = req && req.user && req.user.id;
    if (!userId) {
      return res.status(403).json({
        error: {
          code: 'COMMUNICATION_AUTH_REQUIRED',
          message: 'Authenticated user is required'
        }
      });
    }

    let reservation;
    try {
      reservation = await service.reserve({
        userId,
        operationId: getSwaggerOperationId(req)
      });
    } catch (error) {
      return sendQuotaError(res, error, config);
    }

    req.communicationAiTokenQuotaReservation = reservation;
    res.set('X-AI-Token-Quota-Limit', String(config.monthlyTokens));
    res.set('X-AI-Token-Quota-Remaining', String(reservation.remainingTokens));
    res.set('X-AI-Token-Quota-Reserved', String(reservation.tokens));

    const releaseUnusedReservation = () => {
      service.releaseReservation(reservation).catch(() => {});
    };
    if (res && typeof res.once === 'function') {
      res.once('finish', releaseUnusedReservation);
      res.once('close', releaseUnusedReservation);
    }
    return next();
  };

  middleware.config = config;
  middleware.service = service;
  return middleware;
}

module.exports = {
  AI_TOKEN_OPERATION_KINDS,
  DEFAULT_IMAGE_TOKEN_RESERVATION,
  DEFAULT_MONTHLY_TOKEN_QUOTA,
  DEFAULT_TEXT_TOKEN_RESERVATION,
  MAX_MONTHLY_TOKEN_QUOTA,
  MONTH_RETENTION_SECONDS,
  createCommunicationAiTokenQuotaLimiter,
  createCommunicationAiTokenQuotaMiddleware,
  createCommunicationAiTokenQuotaService,
  createQuotaSnapshot,
  getRequestTokenReservation,
  getSwaggerOperationId,
  resolveCommunicationAiTokenQuotaConfig,
  secondsUntilNextUtcMonth
};

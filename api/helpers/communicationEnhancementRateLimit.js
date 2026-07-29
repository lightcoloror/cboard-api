'use strict';

const crypto = require('crypto');
const { RateLimiterMongo } = require('rate-limiter-flexible');

const DEFAULT_POINTS_PER_MINUTE = 30;
const DEFAULT_MONTHLY_POINTS = 1000;
const MINUTE_DURATION_SECONDS = 60;
const MONTH_RETENTION_SECONDS = 32 * 24 * 60 * 60;
const OPERATION_COSTS = Object.freeze({
  editPhrase: 1,
  generateCommunicationSentences: 2,
  normalizeCommunicationDialectText: 2,
  resegmentCommunicationText: 2,
  synthesizeCommunicationSpeech: 2,
  recognizeCommunicationDialectAudio: 4,
  recognizeCommunicationImageText: 4,
  suggestCommunicationPictogramMetadata: 4,
  generateCommunicationPictogram: 8,
  removeCommunicationImageBackground: 4,
  convertCommunicationAacFile: 4
});

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function resolveCommunicationEnhancementRateLimitConfig(
  env = process.env,
  environment = process.env.NODE_ENV
) {
  const setting = String(
    env.COMMUNICATION_ENHANCEMENT_RATE_LIMIT_ENABLED || ''
  )
    .trim()
    .toLowerCase();
  const enabled =
    setting === 'true' ||
    (!setting && String(environment || '').toLowerCase() === 'production');

  return Object.freeze({
    enabled,
    pointsPerMinute: boundedInteger(
      env.COMMUNICATION_ENHANCEMENT_POINTS_PER_MINUTE,
      DEFAULT_POINTS_PER_MINUTE,
      1,
      10000
    ),
    monthlyPoints: boundedInteger(
      env.COMMUNICATION_ENHANCEMENT_MONTHLY_POINTS,
      DEFAULT_MONTHLY_POINTS,
      1,
      10000000
    )
  });
}

function createCommunicationEnhancementMongoLimiters({
  storeClient,
  config,
  RateLimiterClass = RateLimiterMongo
}) {
  if (!storeClient) {
    throw new TypeError('Mongo connection is required for enhancement limits');
  }

  return {
    minute: new RateLimiterClass({
      storeClient,
      keyPrefix: 'communication_enhancement_minute',
      tableName: 'communicationEnhancementMinuteLimits',
      points: config.pointsPerMinute,
      duration: MINUTE_DURATION_SECONDS
    }),
    monthly: new RateLimiterClass({
      storeClient,
      keyPrefix: 'communication_enhancement_month',
      tableName: 'communicationEnhancementMonthlyLimits',
      points: config.monthlyPoints,
      duration: MONTH_RETENTION_SECONDS
    })
  };
}

function hashRateLimitIdentity(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}

function buildMonthlyRateLimitKey(identityHash, now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}:${identityHash}`;
}

function millisecondsUntilNextUtcMonth(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const nextMonth = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    1
  );
  return Math.max(1000, nextMonth - date.getTime());
}

function getOperationCost(req) {
  const operationId =
    req &&
    req.swagger &&
    req.swagger.operation &&
    req.swagger.operation.operationId;
  return OPERATION_COSTS[operationId] || 0;
}

function isRateLimitRejection(value) {
  return Boolean(
    value &&
      !(value instanceof Error) &&
      Number.isFinite(Number(value.msBeforeNext))
  );
}

function setAllowedHeaders(res, config, minuteResult, monthlyResult) {
  res.set('RateLimit-Limit', String(config.pointsPerMinute));
  res.set(
    'RateLimit-Remaining',
    String(Math.max(0, Number(minuteResult.remainingPoints) || 0))
  );
  res.set(
    'X-Monthly-Quota-Limit',
    String(config.monthlyPoints)
  );
  res.set(
    'X-Monthly-Quota-Remaining',
    String(Math.max(0, Number(monthlyResult.remainingPoints) || 0))
  );
}

function sendLimitExceeded(res, scope, rejection, config, now) {
  const retryMilliseconds =
    scope === 'month'
      ? millisecondsUntilNextUtcMonth(now)
      : Number(rejection.msBeforeNext);
  const retryAfter = Math.max(
    1,
    Math.ceil(retryMilliseconds / 1000)
  );
  res.set('Retry-After', String(retryAfter));
  res.set('X-RateLimit-Scope', scope);
  if (scope === 'month') {
    res.set('X-Monthly-Quota-Limit', String(config.monthlyPoints));
    res.set('X-Monthly-Quota-Remaining', '0');
  } else {
    res.set('RateLimit-Limit', String(config.pointsPerMinute));
    res.set('RateLimit-Remaining', '0');
  }
  return res.status(429).json({
    error: {
      code:
        scope === 'month'
          ? 'COMMUNICATION_MONTHLY_QUOTA_EXCEEDED'
          : 'COMMUNICATION_RATE_LIMITED',
      message:
        scope === 'month'
          ? 'Monthly communication enhancement quota exceeded'
          : 'Communication enhancement rate limit exceeded'
    }
  });
}

function createCommunicationEnhancementRateLimitMiddleware(options = {}) {
  const config =
    options.config ||
    resolveCommunicationEnhancementRateLimitConfig(
      options.env,
      options.environment
    );
  const now = options.now || (() => new Date());
  const limiters = config.enabled
    ? options.limiters ||
      createCommunicationEnhancementMongoLimiters({
        storeClient: options.storeClient,
        config,
        RateLimiterClass: options.RateLimiterClass
      })
    : null;

  const middleware = async function communicationEnhancementRateLimit(
    req,
    res,
    next
  ) {
    const cost = getOperationCost(req);
    if (!config.enabled || !cost) return next();

    const userId = req && req.user && req.user.id;
    if (!userId) {
      return res.status(403).json({
        error: {
          code: 'COMMUNICATION_AUTH_REQUIRED',
          message: 'Authenticated user is required'
        }
      });
    }

    const identityHash = hashRateLimitIdentity(userId);
    let minuteResult;
    try {
      minuteResult = await limiters.minute.consume(identityHash, cost);
    } catch (error) {
      if (isRateLimitRejection(error)) {
        return sendLimitExceeded(res, 'minute', error, config, now());
      }
      return res.status(503).json({
        error: {
          code: 'COMMUNICATION_RATE_LIMIT_UNAVAILABLE',
          message: 'Communication enhancement limit store is unavailable'
        }
      });
    }

    let monthlyResult;
    try {
      monthlyResult = await limiters.monthly.consume(
        buildMonthlyRateLimitKey(identityHash, now()),
        cost
      );
    } catch (error) {
      if (isRateLimitRejection(error)) {
        return sendLimitExceeded(res, 'month', error, config, now());
      }
      return res.status(503).json({
        error: {
          code: 'COMMUNICATION_RATE_LIMIT_UNAVAILABLE',
          message: 'Communication enhancement limit store is unavailable'
        }
      });
    }

    setAllowedHeaders(res, config, minuteResult, monthlyResult);
    return next();
  };

  middleware.config = config;
  return middleware;
}

module.exports = {
  DEFAULT_MONTHLY_POINTS,
  DEFAULT_POINTS_PER_MINUTE,
  MINUTE_DURATION_SECONDS,
  MONTH_RETENTION_SECONDS,
  OPERATION_COSTS,
  buildMonthlyRateLimitKey,
  createCommunicationEnhancementMongoLimiters,
  createCommunicationEnhancementRateLimitMiddleware,
  getOperationCost,
  hashRateLimitIdentity,
  millisecondsUntilNextUtcMonth,
  resolveCommunicationEnhancementRateLimitConfig
};

'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { RateLimiterMongo } = require('rate-limiter-flexible');

const OPERATIONS = Object.freeze({
  registration: Object.freeze({
    codePrefix: 'USER_REGISTRATION',
    keyPrefix: 'user_registration',
    emailTable: 'userRegistrationEmailHourlyLimits',
    ipTable: 'userRegistrationIpHourlyLimits',
    emailEnv: 'USER_REGISTRATION_RATE_LIMIT_EMAIL_HOURLY_LIMIT',
    ipEnv: 'USER_REGISTRATION_RATE_LIMIT_IP_HOURLY_LIMIT',
    emailDefault: 3,
    ipDefault: 20
  }),
  passwordReset: Object.freeze({
    codePrefix: 'PASSWORD_RESET',
    keyPrefix: 'password_reset',
    emailTable: 'passwordResetEmailHourlyLimits',
    ipTable: 'passwordResetIpHourlyLimits',
    emailEnv: 'PASSWORD_RESET_RATE_LIMIT_EMAIL_HOURLY_LIMIT',
    ipEnv: 'PASSWORD_RESET_RATE_LIMIT_IP_HOURLY_LIMIT',
    emailDefault: 3,
    ipDefault: 20
  }),
  login: Object.freeze({
    codePrefix: 'LOGIN',
    keyPrefix: 'login',
    emailTable: 'loginEmailHourlyLimits',
    ipTable: 'loginIpHourlyLimits',
    emailEnv: 'LOGIN_RATE_LIMIT_EMAIL_HOURLY_LIMIT',
    ipEnv: 'LOGIN_RATE_LIMIT_IP_HOURLY_LIMIT',
    emailDefault: 20,
    ipDefault: 100
  })
});

function boundedInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100000
    ? parsed
    : fallback;
}

function resolveAuthRequestRateLimitConfig(env = process.env) {
  return Object.freeze(
    Object.keys(OPERATIONS).reduce((result, operation) => {
      const policy = OPERATIONS[operation];
      result[operation] = Object.freeze({
        emailHourlyLimit: boundedInteger(
          env[policy.emailEnv],
          policy.emailDefault
        ),
        ipHourlyLimit: boundedInteger(env[policy.ipEnv], policy.ipDefault)
      });
      return result;
    }, {})
  );
}

function hashRateLimitIdentity(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}

function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function createAuthRequestMongoLimiters({
  storeClient,
  operation,
  config = resolveAuthRequestRateLimitConfig(),
  RateLimiterClass = RateLimiterMongo
}) {
  const policy = OPERATIONS[operation];
  if (!policy)
    throw new TypeError(`Unknown auth rate limit operation: ${operation}`);
  if (!storeClient)
    throw new TypeError('Mongo connection is required for auth request limits');
  const limits = config[operation] || config;
  return {
    emailHourly: new RateLimiterClass({
      storeClient,
      keyPrefix: `${policy.keyPrefix}_email_hour`,
      tableName: policy.emailTable,
      points: limits.emailHourlyLimit,
      duration: 60 * 60
    }),
    ipHourly: new RateLimiterClass({
      storeClient,
      keyPrefix: `${policy.keyPrefix}_ip_hour`,
      tableName: policy.ipTable,
      points: limits.ipHourlyLimit,
      duration: 60 * 60
    })
  };
}

function isLimiterRejection(value) {
  return Boolean(
    value &&
      !(value instanceof Error) &&
      Number.isFinite(Number(value.msBeforeNext))
  );
}

async function consumeLimiter(limiter, key, codePrefix) {
  try {
    return await limiter.consume(key, 1);
  } catch (error) {
    if (isLimiterRejection(error)) {
      const limited = new Error('Too many authentication requests.');
      limited.status = 429;
      limited.code = `${codePrefix}_RATE_LIMITED`;
      limited.retryAfter = Math.max(
        1,
        Math.ceil(Number(error.msBeforeNext) / 1000)
      );
      throw limited;
    }
    const unavailable = new Error('Authentication rate limit unavailable.');
    unavailable.status = 503;
    unavailable.code = `${codePrefix}_RATE_LIMIT_UNAVAILABLE`;
    throw unavailable;
  }
}

async function consumeAuthRequestLimits({ limiters, operation, email, ip }) {
  const policy = OPERATIONS[operation];
  if (!policy)
    throw new TypeError(`Unknown auth rate limit operation: ${operation}`);
  await consumeLimiter(
    limiters.ipHourly,
    hashRateLimitIdentity(`ip:${String(ip || 'unknown')}`),
    policy.codePrefix
  );
  await consumeLimiter(
    limiters.emailHourly,
    hashRateLimitIdentity(`email:${normalizeEmail(email)}`),
    policy.codePrefix
  );
}

function createAuthRequestRateLimitRuntime(options = {}) {
  if (options.limiters) {
    return {
      getLimiters(operation) {
        const value = options.limiters[operation] || options.limiters;
        return value && value.limiters ? value.limiters : value;
      }
    };
  }
  const config = options.config || resolveAuthRequestRateLimitConfig();
  const storeClient = options.storeClient || mongoose.connection;
  const cached = {};
  return {
    getLimiters(operation) {
      if (!cached[operation]) {
        cached[operation] = createAuthRequestMongoLimiters({
          storeClient,
          operation,
          config,
          RateLimiterClass: options.RateLimiterClass
        });
      }
      return cached[operation];
    }
  };
}

const authRequestRateLimit = createAuthRequestRateLimitRuntime();
function getAuthRequestLimiters(operation) {
  return authRequestRateLimit.getLimiters(operation);
}

module.exports = {
  DEFAULT_EMAIL_HOURLY_LIMIT: 3,
  DEFAULT_IP_HOURLY_LIMIT: 20,
  OPERATIONS,
  authRequestRateLimit,
  consumeAuthRequestLimits,
  createAuthRequestMongoLimiters,
  createAuthRequestRateLimitRuntime,
  hashRateLimitIdentity,
  isLimiterRejection,
  getAuthRequestLimiters,
  normalizeEmail,
  resolveAuthRequestRateLimitConfig
};

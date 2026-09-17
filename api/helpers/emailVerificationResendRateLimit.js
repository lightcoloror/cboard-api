'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { RateLimiterMongo } = require('rate-limiter-flexible');

const DEFAULT_RESEND_SECONDS = 60;
const DEFAULT_EMAIL_DAILY_LIMIT = 2;
const DEFAULT_IP_HOURLY_LIMIT = 20;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function resolveEmailVerificationResendLimitConfig(env = process.env) {
  return Object.freeze({
    resendSeconds: boundedInteger(
      env.EMAIL_VERIFICATION_RESEND_SECONDS,
      DEFAULT_RESEND_SECONDS,
      1,
      24 * 60 * 60
    ),
    emailDailyLimit: boundedInteger(
      env.EMAIL_VERIFICATION_RESEND_EMAIL_DAILY_LIMIT,
      DEFAULT_EMAIL_DAILY_LIMIT,
      1,
      10000
    ),
    ipHourlyLimit: boundedInteger(
      env.EMAIL_VERIFICATION_RESEND_IP_HOURLY_LIMIT,
      DEFAULT_IP_HOURLY_LIMIT,
      1,
      100000
    )
  });
}

function hashRateLimitIdentity(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}

function createEmailVerificationResendMongoLimiters({
  storeClient,
  config = resolveEmailVerificationResendLimitConfig(),
  RateLimiterClass = RateLimiterMongo
}) {
  if (!storeClient) {
    throw new TypeError('Mongo connection is required for email resend limits');
  }

  return {
    resend: new RateLimiterClass({
      storeClient,
      keyPrefix: 'email_verification_resend',
      tableName: 'emailVerificationResendLimits',
      points: 1,
      duration: config.resendSeconds
    }),
    emailDaily: new RateLimiterClass({
      storeClient,
      keyPrefix: 'email_verification_email_day',
      tableName: 'emailVerificationEmailDailyLimits',
      points: config.emailDailyLimit,
      duration: 24 * 60 * 60
    }),
    ipHourly: new RateLimiterClass({
      storeClient,
      keyPrefix: 'email_verification_ip_hour',
      tableName: 'emailVerificationIpHourlyLimits',
      points: config.ipHourlyLimit,
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

function createLimitError(rejection) {
  const error = new Error('Too many verification requests.');
  error.status = 429;
  error.code = 'EMAIL_VERIFICATION_RATE_LIMITED';
  error.retryAfter = Math.max(
    1,
    Math.ceil(Number(rejection.msBeforeNext) / 1000)
  );
  return error;
}

async function consumeLimiter(limiter, key) {
  try {
    return await limiter.consume(key, 1);
  } catch (error) {
    if (isLimiterRejection(error)) throw createLimitError(error);
    const unavailable = new Error('Email verification rate limit unavailable.');
    unavailable.status = 503;
    unavailable.code = 'EMAIL_VERIFICATION_RATE_LIMIT_UNAVAILABLE';
    throw unavailable;
  }
}

async function consumeEmailVerificationResendLimits({ limiters, email, ip }) {
  const emailKey = hashRateLimitIdentity(`email:${String(email || '')}`);
  const ipKey = hashRateLimitIdentity(`ip:${String(ip || 'unknown')}`);
  await consumeLimiter(limiters.ipHourly, ipKey);
  await consumeLimiter(limiters.emailDaily, emailKey);
  await consumeLimiter(limiters.resend, emailKey);
}

function createEmailVerificationResendRateLimitRuntime(options = {}) {
  if (options.limiters) return { limiters: options.limiters };

  const config = options.config || resolveEmailVerificationResendLimitConfig();
  const storeClient = options.storeClient || mongoose.connection;
  let limiters;
  return {
    get limiters() {
      if (!limiters) {
        limiters = createEmailVerificationResendMongoLimiters({
          storeClient,
          config,
          RateLimiterClass: options.RateLimiterClass
        });
      }
      return limiters;
    }
  };
}

const emailVerificationResendRateLimit = createEmailVerificationResendRateLimitRuntime();

module.exports = {
  DEFAULT_EMAIL_DAILY_LIMIT,
  DEFAULT_IP_HOURLY_LIMIT,
  DEFAULT_RESEND_SECONDS,
  consumeEmailVerificationResendLimits,
  createEmailVerificationResendMongoLimiters,
  createEmailVerificationResendRateLimitRuntime,
  emailVerificationResendRateLimit,
  hashRateLimitIdentity,
  isLimiterRejection,
  resolveEmailVerificationResendLimitConfig
};

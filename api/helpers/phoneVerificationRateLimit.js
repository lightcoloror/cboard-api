'use strict';

const { RateLimiterMongo } = require('rate-limiter-flexible');
const {
  hashRateLimitIdentity
} = require('./communicationEnhancementRateLimit');

const RESEND_SECONDS = 60;
const PHONE_DAILY_LIMIT = 2;
const IP_HOURLY_LIMIT = 20;

function createPhoneVerificationMongoLimiters({
  storeClient,
  RateLimiterClass = RateLimiterMongo
}) {
  if (!storeClient) {
    throw new TypeError(
      'Mongo connection is required for phone verification limits'
    );
  }
  return {
    resend: new RateLimiterClass({
      storeClient,
      keyPrefix: 'phone_verification_resend',
      tableName: 'phoneVerificationResendLimits',
      points: 1,
      duration: RESEND_SECONDS
    }),
    phoneDaily: new RateLimiterClass({
      storeClient,
      keyPrefix: 'phone_verification_phone_day',
      tableName: 'phoneVerificationPhoneDailyLimits',
      points: PHONE_DAILY_LIMIT,
      duration: 24 * 60 * 60
    }),
    ipHourly: new RateLimiterClass({
      storeClient,
      keyPrefix: 'phone_verification_ip_hour',
      tableName: 'phoneVerificationIpHourlyLimits',
      points: IP_HOURLY_LIMIT,
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
  const error = new Error('Too many phone verification requests.');
  error.status = 429;
  error.code = 'PHONE_VERIFICATION_RATE_LIMITED';
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
    const unavailable = new Error(
      'Phone verification rate limit store is unavailable.'
    );
    unavailable.status = 503;
    unavailable.code = 'PHONE_VERIFICATION_RATE_LIMIT_UNAVAILABLE';
    throw unavailable;
  }
}

async function consumePhoneVerificationSendLimits({ limiters, phone, ip }) {
  const phoneKey = hashRateLimitIdentity(`phone:${phone}`);
  const ipKey = hashRateLimitIdentity(`ip:${String(ip || 'unknown')}`);
  await consumeLimiter(limiters.ipHourly, ipKey);
  await consumeLimiter(limiters.phoneDaily, phoneKey);
  await consumeLimiter(limiters.resend, phoneKey);
}

module.exports = {
  IP_HOURLY_LIMIT,
  PHONE_DAILY_LIMIT,
  RESEND_SECONDS,
  consumePhoneVerificationSendLimits,
  createPhoneVerificationMongoLimiters,
  isLimiterRejection
};

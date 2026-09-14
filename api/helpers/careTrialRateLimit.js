'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');
const { RateLimiterMongo } = require('rate-limiter-flexible');

const DEFAULT_ACCOUNT_HOURLY_LIMIT = 3;
const DEFAULT_IP_HOURLY_LIMIT = 20;
const hashRateLimitIdentity = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');

function boundedInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100000 ? parsed : fallback;
}

function resolveCareTrialLimitConfig(env = process.env) {
  return Object.freeze({
    accountHourlyLimit: boundedInteger(env.CARE_TRIAL_ACCOUNT_HOURLY_LIMIT, DEFAULT_ACCOUNT_HOURLY_LIMIT),
    ipHourlyLimit: boundedInteger(env.CARE_TRIAL_IP_HOURLY_LIMIT, DEFAULT_IP_HOURLY_LIMIT)
  });
}

function createCareTrialMongoLimiters({ storeClient, config = resolveCareTrialLimitConfig(), RateLimiterClass = RateLimiterMongo }) {
  if (!storeClient) throw new TypeError('Mongo connection is required for care trial limits');
  return {
    accountHourly: new RateLimiterClass({ storeClient, keyPrefix: 'care_trial_account_hour', tableName: 'careTrialAccountHourlyLimits', points: config.accountHourlyLimit, duration: 3600 }),
    ipHourly: new RateLimiterClass({ storeClient, keyPrefix: 'care_trial_ip_hour', tableName: 'careTrialIpHourlyLimits', points: config.ipHourlyLimit, duration: 3600 })
  };
}

function isLimiterRejection(value) {
  return Boolean(value && !(value instanceof Error) && Number.isFinite(Number(value.msBeforeNext)));
}

async function consume(limiter, key) {
  try { return await limiter.consume(key, 1); } catch (error) {
    if (isLimiterRejection(error)) {
      const limited = new Error('Too many trial claim requests.');
      limited.status = 429; limited.code = 'CARE_TRIAL_RATE_LIMITED';
      limited.retryAfter = Math.max(1, Math.ceil(Number(error.msBeforeNext) / 1000));
      throw limited;
    }
    const unavailable = new Error('Care trial rate limit unavailable.');
    unavailable.status = 503; unavailable.code = 'CARE_TRIAL_RATE_LIMIT_UNAVAILABLE';
    throw unavailable;
  }
}

async function consumeCareTrialLimits({ limiters, accountId, ip }) {
  await consume(limiters.ipHourly, hashRateLimitIdentity(`ip:${String(ip || 'unknown')}`));
  await consume(limiters.accountHourly, hashRateLimitIdentity(`account:${accountId}`));
}

function createCareTrialRateLimitRuntime(options = {}) {
  return { limiters: options.limiters || createCareTrialMongoLimiters({ storeClient: options.storeClient || mongoose.connection, config: options.config, RateLimiterClass: options.RateLimiterClass }) };
}

module.exports = { DEFAULT_ACCOUNT_HOURLY_LIMIT, DEFAULT_IP_HOURLY_LIMIT, consumeCareTrialLimits, createCareTrialMongoLimiters, createCareTrialRateLimitRuntime, hashRateLimitIdentity, isLimiterRejection, resolveCareTrialLimitConfig };

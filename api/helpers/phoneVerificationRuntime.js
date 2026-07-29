'use strict';

const mongoose = require('mongoose');
const PhoneVerificationChallenge = require('../models/PhoneVerificationChallenge');
const {
  createPhoneVerificationProvider
} = require('./phoneVerificationProvider');
const {
  createPhoneVerificationMongoLimiters
} = require('./phoneVerificationRateLimit');
const {
  createPhoneVerificationRepository
} = require('./phoneVerificationRepository');
const {
  createPhoneVerificationService,
  resolvePhoneVerificationConfiguration
} = require('./phoneVerificationService');

function createPhoneVerificationRuntime(options = {}) {
  const env = options.env || process.env;
  const configuration =
    options.configuration || resolvePhoneVerificationConfiguration(env);
  const provider =
    options.provider ||
    createPhoneVerificationProvider({
      configuration: configuration.providerConfiguration,
      env
    });
  const repository =
    options.repository ||
    createPhoneVerificationRepository(PhoneVerificationChallenge);
  const limiters = configuration.available
    ? options.limiters ||
      createPhoneVerificationMongoLimiters({
        storeClient: options.storeClient || mongoose.connection
      })
    : null;
  return createPhoneVerificationService({
    configuration,
    provider,
    repository,
    limiters,
    now: options.now,
    randomBytes: options.randomBytes,
    randomInt: options.randomInt
  });
}

const phoneVerificationService = createPhoneVerificationRuntime();

module.exports = {
  createPhoneVerificationRuntime,
  phoneVerificationService
};

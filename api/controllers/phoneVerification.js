'use strict';

const {
  phoneVerificationService
} = require('../helpers/phoneVerificationRuntime');

function sendError(res, error) {
  const status =
    Number.isInteger(error && error.status) &&
    error.status >= 400 &&
    error.status <= 504
      ? error.status
      : 500;
  const code = /^PHONE_VERIFICATION_[A-Z_]+$/.test(
    String((error && error.code) || '')
  )
    ? error.code
    : 'PHONE_VERIFICATION_FAILED';
  if (error && error.retryAfter) {
    res.set('Retry-After', String(error.retryAfter));
  }
  return res.status(status).json({
    message: status === 500 ? 'Phone verification failed.' : error.message,
    error: { code }
  });
}

function createPhoneVerificationController(service) {
  return {
    getPhoneVerificationConfiguration(req, res) {
      return res.status(200).json(service.getConfiguration());
    },

    async requestPhoneVerification(req, res) {
      try {
        const body = req.body || {};
        const value = await service.requestChallenge({
          phone: body.phone,
          purpose: body.purpose,
          ip: req.ip
        });
        return res.status(200).json(value);
      } catch (error) {
        return sendError(res, error);
      }
    },

    async confirmPhoneVerification(req, res) {
      try {
        const body = req.body || {};
        const value = await service.confirmChallenge({
          challengeId: body.challengeId,
          phone: body.phone,
          code: body.code,
          purpose: body.purpose
        });
        return res.status(200).json(value);
      } catch (error) {
        return sendError(res, error);
      }
    }
  };
}

module.exports = {
  ...createPhoneVerificationController(phoneVerificationService),
  createPhoneVerificationController,
  sendError
};

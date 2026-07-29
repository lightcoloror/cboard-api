'use strict';

module.exports = {
  getPhoneVerificationConfiguration(req, res) {
    return res.status(200).json({
      available: true,
      phoneLoginAvailable: true,
      phonePasswordResetAvailable: true,
      requiredForPhoneRegistration: true,
      challengeExpiresInSeconds: 300,
      verificationExpiresInSeconds: 600,
      resendAfterSeconds: 60,
      codeLength: 6
    });
  },
  requestPhoneVerification(req, res) {
    return res.status(200).json({
      challengeId: 'a'.repeat(64),
      phoneMasked: '138****8000',
      expiresInSeconds: 300,
      resendAfterSeconds: 60
    });
  },
  confirmPhoneVerification(req, res) {
    return res.status(200).json({
      verificationToken: 'b'.repeat(64),
      expiresInSeconds: 600
    });
  }
};

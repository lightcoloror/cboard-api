'use strict';

const crypto = require('crypto');
const {
  isValidMainlandChinaPhone,
  maskMainlandChinaPhone,
  normalizeMainlandChinaPhone
} = require('./userPhone');
const {
  RESEND_SECONDS,
  consumePhoneVerificationSendLimits
} = require('./phoneVerificationRateLimit');
const {
  resolveTencentCloudSmsConfiguration
} = require('./phoneVerificationProvider');

const CHALLENGE_TTL_SECONDS = 5 * 60;
const VERIFICATION_TOKEN_TTL_SECONDS = 10 * 60;
const MAX_CONFIRM_ATTEMPTS = 5;
const CODE_PATTERN = /^\d{6}$/;
const OPAQUE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const PHONE_VERIFICATION_PURPOSES = Object.freeze([
  'registration',
  'login',
  'password-reset'
]);
const DEFAULT_PHONE_VERIFICATION_PURPOSE = 'registration';

function parseBoolean(value) {
  return (
    String(value || '')
      .trim()
      .toLowerCase() === 'true'
  );
}

function resolvePhoneVerificationConfiguration(env = process.env) {
  const providerConfiguration = resolveTencentCloudSmsConfiguration(env);
  const hashSecret = String(env.PHONE_VERIFICATION_HASH_SECRET || '');
  const available = Boolean(
    providerConfiguration && Buffer.byteLength(hashSecret, 'utf8') >= 32
  );
  return Object.freeze({
    available,
    requiredForPhoneRegistration: parseBoolean(env.PHONE_VERIFICATION_REQUIRED),
    hashSecret,
    providerConfiguration
  });
}

function createServiceError(message, status, code, retryAfter) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (retryAfter) error.retryAfter = retryAfter;
  return error;
}

function normalizePhoneVerificationPurpose(value) {
  const purpose = String(value || DEFAULT_PHONE_VERIFICATION_PURPOSE)
    .trim()
    .toLowerCase();
  if (!PHONE_VERIFICATION_PURPOSES.includes(purpose)) {
    throw createServiceError(
      'Phone verification purpose is invalid.',
      400,
      'PHONE_VERIFICATION_INVALID_PURPOSE'
    );
  }
  return purpose;
}

function hashValue(secret, namespace, value) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${namespace}:${value}`)
    .digest('hex');
}

function hashPhone(secret, phone) {
  return hashValue(secret, 'phone', phone);
}

function hashCode(secret, challengeId, phoneHash, code) {
  return hashValue(secret, 'code', `${challengeId}:${phoneHash}:${code}`);
}

function hashVerificationToken(secret, token) {
  return hashValue(secret, 'token', token);
}

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/.test(String(left || ''))) return false;
  if (!/^[a-f0-9]{64}$/.test(String(right || ''))) return false;
  return crypto.timingSafeEqual(
    Buffer.from(left, 'hex'),
    Buffer.from(right, 'hex')
  );
}

function getPublicConfiguration(configuration) {
  return {
    available: configuration.available,
    phoneLoginAvailable: configuration.available,
    phonePasswordResetAvailable: configuration.available,
    requiredForPhoneRegistration: configuration.requiredForPhoneRegistration,
    challengeExpiresInSeconds: CHALLENGE_TTL_SECONDS,
    verificationExpiresInSeconds: VERIFICATION_TOKEN_TTL_SECONDS,
    resendAfterSeconds: RESEND_SECONDS,
    codeLength: 6
  };
}

function normalizeKnownError(error) {
  if (
    error &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 504 &&
    /^PHONE_VERIFICATION_[A-Z_]+$/.test(String(error.code || ''))
  ) {
    return error;
  }
  return createServiceError(
    'Phone verification is temporarily unavailable.',
    503,
    'PHONE_VERIFICATION_UNAVAILABLE'
  );
}

function createPhoneVerificationService(options) {
  const configuration = options.configuration;
  const provider = options.provider;
  const repository = options.repository;
  const limiters = options.limiters;
  const now = options.now || (() => new Date());
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const randomInt = options.randomInt || crypto.randomInt;

  function requireAvailable() {
    if (!configuration.available || !provider || !repository || !limiters) {
      throw createServiceError(
        'Phone verification is not configured.',
        503,
        'PHONE_VERIFICATION_NOT_CONFIGURED'
      );
    }
  }

  return {
    configuration,

    getConfiguration() {
      return getPublicConfiguration(configuration);
    },

    async requestChallenge({ phone: inputPhone, ip, purpose: inputPurpose }) {
      requireAvailable();
      const purpose = normalizePhoneVerificationPurpose(inputPurpose);
      const phone = normalizeMainlandChinaPhone(inputPhone);
      if (!isValidMainlandChinaPhone(phone)) {
        throw createServiceError(
          'Please enter a valid 11-digit mainland China phone number.',
          400,
          'PHONE_VERIFICATION_INVALID_PHONE'
        );
      }

      try {
        await consumePhoneVerificationSendLimits({ limiters, phone, ip });
      } catch (error) {
        throw normalizeKnownError(error);
      }

      const challengeId = randomBytes(32).toString('hex');
      const code = String(randomInt(100000, 1000000));
      const phoneHash = hashPhone(configuration.hashSecret, phone);
      const codeHash = hashCode(
        configuration.hashSecret,
        challengeId,
        phoneHash,
        code
      );
      const issuedAt = now();
      const expiresAt = new Date(
        issuedAt.getTime() + CHALLENGE_TTL_SECONDS * 1000
      );

      try {
        await repository.create({
          challengeId,
          phoneHash,
          phoneMasked: maskMainlandChinaPhone(phone),
          purpose,
          codeHash,
          attempts: 0,
          provider: provider.id,
          expiresAt
        });
      } catch (error) {
        throw normalizeKnownError(error);
      }

      let providerResult;
      try {
        providerResult = await provider.sendCode({
          phone,
          code,
          expiresInMinutes: Math.ceil(CHALLENGE_TTL_SECONDS / 60),
          challengeId
        });
      } catch (error) {
        try {
          await repository.remove(challengeId);
        } catch (cleanupError) {}
        throw normalizeKnownError(error);
      }

      try {
        await repository.setProviderRequestId(
          challengeId,
          providerResult && providerResult.requestId
        );
      } catch (error) {}

      return {
        challengeId,
        phoneMasked: maskMainlandChinaPhone(phone),
        expiresInSeconds: CHALLENGE_TTL_SECONDS,
        resendAfterSeconds: RESEND_SECONDS
      };
    },

    async confirmChallenge({
      challengeId,
      phone: inputPhone,
      code,
      purpose: inputPurpose
    }) {
      requireAvailable();
      const purpose = normalizePhoneVerificationPurpose(inputPurpose);
      const normalizedChallengeId = String(challengeId || '')
        .trim()
        .toLowerCase();
      const phone = normalizeMainlandChinaPhone(inputPhone);
      const normalizedCode = String(code || '').trim();
      if (
        !OPAQUE_TOKEN_PATTERN.test(normalizedChallengeId) ||
        !isValidMainlandChinaPhone(phone) ||
        !CODE_PATTERN.test(normalizedCode)
      ) {
        throw createServiceError(
          'The phone verification code is invalid or expired.',
          400,
          'PHONE_VERIFICATION_INVALID_CODE'
        );
      }

      const checkedAt = now();
      const phoneHash = hashPhone(configuration.hashSecret, phone);
      let challenge;
      try {
        challenge = await repository.getActiveChallenge({
          challengeId: normalizedChallengeId,
          phoneHash,
          purpose,
          now: checkedAt
        });
      } catch (error) {
        throw normalizeKnownError(error);
      }
      if (!challenge || challenge.verifiedAt) {
        throw createServiceError(
          'The phone verification code is invalid or expired.',
          400,
          'PHONE_VERIFICATION_INVALID_CODE'
        );
      }
      if (Number(challenge.attempts) >= MAX_CONFIRM_ATTEMPTS) {
        throw createServiceError(
          'Too many phone verification attempts.',
          429,
          'PHONE_VERIFICATION_TOO_MANY_ATTEMPTS'
        );
      }

      const expectedCodeHash = hashCode(
        configuration.hashSecret,
        normalizedChallengeId,
        phoneHash,
        normalizedCode
      );
      if (!safeEqualHex(expectedCodeHash, challenge.codeHash)) {
        let updated;
        try {
          updated = await repository.recordInvalidAttempt({
            challengeId: normalizedChallengeId,
            phoneHash,
            purpose,
            now: checkedAt,
            maxAttempts: MAX_CONFIRM_ATTEMPTS
          });
        } catch (error) {
          throw normalizeKnownError(error);
        }
        if (!updated || Number(updated.attempts) >= MAX_CONFIRM_ATTEMPTS) {
          throw createServiceError(
            'Too many phone verification attempts.',
            429,
            'PHONE_VERIFICATION_TOO_MANY_ATTEMPTS'
          );
        }
        throw createServiceError(
          'The phone verification code is invalid or expired.',
          400,
          'PHONE_VERIFICATION_INVALID_CODE'
        );
      }

      const verificationToken = randomBytes(32).toString('hex');
      const tokenHash = hashVerificationToken(
        configuration.hashSecret,
        verificationToken
      );
      const verificationExpiresAt = new Date(
        checkedAt.getTime() + VERIFICATION_TOKEN_TTL_SECONDS * 1000
      );
      let verified;
      try {
        verified = await repository.markVerified({
          challengeId: normalizedChallengeId,
          phoneHash,
          purpose,
          codeHash: challenge.codeHash,
          now: checkedAt,
          tokenHash,
          verificationExpiresAt,
          maxAttempts: MAX_CONFIRM_ATTEMPTS
        });
      } catch (error) {
        throw normalizeKnownError(error);
      }
      if (!verified) {
        throw createServiceError(
          'The phone verification code was already used.',
          409,
          'PHONE_VERIFICATION_ALREADY_USED'
        );
      }
      return {
        verificationToken,
        expiresInSeconds: VERIFICATION_TOKEN_TTL_SECONDS
      };
    },

    async consumeRegistrationVerification({ phone, token }) {
      if (!configuration.requiredForPhoneRegistration)
        return { required: false, verified: false };
      await consumeVerification({
        phone,
        token,
        purpose: 'registration',
        failureMessage: 'Verify this phone number before registering.'
      });
      return { required: true, verified: true };
    },

    async consumeLoginVerification({ phone, token }) {
      await consumeVerification({
        phone,
        token,
        purpose: 'login',
        failureMessage: 'Unable to sign in with this phone number.'
      });
      return { verified: true };
    },

    async consumePasswordResetVerification({ phone, token }) {
      await consumeVerification({
        phone,
        token,
        purpose: 'password-reset',
        failureMessage: 'Unable to reset the password for this phone number.'
      });
      return { verified: true };
    }
  };

  async function consumeVerification({
    phone: inputPhone,
    token,
    purpose,
    failureMessage
  }) {
    requireAvailable();
    const phone = normalizeMainlandChinaPhone(inputPhone);
    const verificationToken = String(token || '')
      .trim()
      .toLowerCase();
    if (
      !isValidMainlandChinaPhone(phone) ||
      !OPAQUE_TOKEN_PATTERN.test(verificationToken)
    ) {
      throw createServiceError(
        failureMessage,
        403,
        'PHONE_VERIFICATION_REQUIRED'
      );
    }
    let consumed;
    try {
      consumed = await repository.consumeVerifiedToken({
        phoneHash: hashPhone(configuration.hashSecret, phone),
        tokenHash: hashVerificationToken(
          configuration.hashSecret,
          verificationToken
        ),
        purpose,
        now: now()
      });
    } catch (error) {
      throw normalizeKnownError(error);
    }
    if (!consumed) {
      throw createServiceError(
        failureMessage,
        403,
        'PHONE_VERIFICATION_REQUIRED'
      );
    }
    return consumed;
  }
}

module.exports = {
  CHALLENGE_TTL_SECONDS,
  CODE_PATTERN,
  DEFAULT_PHONE_VERIFICATION_PURPOSE,
  MAX_CONFIRM_ATTEMPTS,
  OPAQUE_TOKEN_PATTERN,
  PHONE_VERIFICATION_PURPOSES,
  VERIFICATION_TOKEN_TTL_SECONDS,
  createPhoneVerificationService,
  createServiceError,
  getPublicConfiguration,
  hashCode,
  hashPhone,
  hashVerificationToken,
  normalizePhoneVerificationPurpose,
  resolvePhoneVerificationConfiguration,
  safeEqualHex
};

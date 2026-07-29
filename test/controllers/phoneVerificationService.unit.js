'use strict';

const chai = require('chai');
const {
  createPhoneVerificationService,
  hashCode
} = require('../../api/helpers/phoneVerificationService');

const expect = chai.expect;

function createHarness(options = {}) {
  let record = null;
  let randomCall = 0;
  const sent = [];
  const repository = {
    async create(value) {
      record = { ...value };
    },
    async remove() {
      record = null;
    },
    async setProviderRequestId(challengeId, providerRequestId) {
      if (record && record.challengeId === challengeId) {
        record.providerRequestId = providerRequestId;
      }
    },
    async getActiveChallenge({ challengeId, phoneHash, purpose, now }) {
      return record &&
        record.challengeId === challengeId &&
        record.phoneHash === phoneHash &&
        record.purpose === purpose &&
        record.expiresAt > now &&
        !record.consumedAt
        ? { ...record }
        : null;
    },
    async recordInvalidAttempt() {
      record.attempts += 1;
      return { ...record };
    },
    async markVerified(value) {
      if (!record || record.verifiedAt || record.codeHash !== value.codeHash) {
        return null;
      }
      record = {
        ...record,
        verifiedAt: value.now,
        verificationTokenHash: value.tokenHash,
        verificationExpiresAt: value.verificationExpiresAt,
        expiresAt: value.verificationExpiresAt
      };
      delete record.codeHash;
      return { ...record };
    },
    async consumeVerifiedToken({ phoneHash, tokenHash, purpose, now }) {
      if (
        !record ||
        record.phoneHash !== phoneHash ||
        record.verificationTokenHash !== tokenHash ||
        record.purpose !== purpose ||
        record.verificationExpiresAt <= now ||
        record.consumedAt
      ) {
        return null;
      }
      record.consumedAt = now;
      return { _id: 'record-id' };
    }
  };
  Object.assign(repository, options.repositoryOverrides || {});
  const configuration = {
    available: options.available !== false,
    requiredForPhoneRegistration: options.required !== false,
    hashSecret: 'test-phone-verification-secret-32-bytes-minimum',
    providerConfiguration: {}
  };
  const service = createPhoneVerificationService({
    configuration,
    repository,
    provider:
      options.provider === null
        ? null
        : {
            id: 'test-sms',
            async sendCode(value) {
              sent.push(value);
              return { requestId: 'provider-request-id' };
            }
          },
    limiters: options.limiters || {
      resend: { consume: async function() {} },
      phoneDaily: { consume: async function() {} },
      ipHourly: { consume: async function() {} }
    },
    now: () => new Date('2026-07-22T01:00:00.000Z'),
    randomInt: () => 123456,
    randomBytes: () => {
      randomCall += 1;
      return Buffer.alloc(32, randomCall === 1 ? 0xaa : 0xbb);
    }
  });
  return {
    service,
    sent,
    getRecord: () => record
  };
}

describe('Phone verification service', function() {
  it('stores only bounded hashes and sends through the provider', async function() {
    const harness = createHarness();

    const value = await harness.service.requestChallenge({
      phone: '138 0013 8000',
      ip: '203.0.113.8'
    });
    const record = harness.getRecord();

    expect(value).to.deep.include({
      challengeId: 'aa'.repeat(32),
      phoneMasked: '138****8000',
      expiresInSeconds: 300,
      resendAfterSeconds: 60
    });
    expect(harness.sent[0]).to.deep.include({
      phone: '13800138000',
      code: '123456',
      challengeId: 'aa'.repeat(32)
    });
    expect(record).not.to.have.property('phone');
    expect(record).not.to.have.property('code');
    expect(record.purpose).to.equal('registration');
    expect(record.phoneHash).to.match(/^[a-f0-9]{64}$/);
    expect(record.codeHash).to.match(/^[a-f0-9]{64}$/);
  });

  it('bounds wrong attempts and issues one short-lived token', async function() {
    const harness = createHarness();
    const challenge = await harness.service.requestChallenge({
      phone: '13800138000',
      ip: '203.0.113.8'
    });

    let wrong;
    try {
      await harness.service.confirmChallenge({
        challengeId: challenge.challengeId,
        phone: '13800138000',
        code: '000000'
      });
    } catch (error) {
      wrong = error;
    }
    expect(wrong.code).to.equal('PHONE_VERIFICATION_INVALID_CODE');
    expect(harness.getRecord().attempts).to.equal(1);

    const confirmed = await harness.service.confirmChallenge({
      challengeId: challenge.challengeId,
      phone: '13800138000',
      code: '123456'
    });
    expect(confirmed).to.deep.equal({
      verificationToken: 'bb'.repeat(32),
      expiresInSeconds: 600
    });
    expect(harness.getRecord()).not.to.have.property('codeHash');
  });

  it('consumes a verified token once and binds it to the phone', async function() {
    const harness = createHarness();
    const challenge = await harness.service.requestChallenge({
      phone: '13800138000',
      ip: '203.0.113.8'
    });
    const confirmed = await harness.service.confirmChallenge({
      challengeId: challenge.challengeId,
      phone: '13800138000',
      code: '123456'
    });

    expect(
      await harness.service.consumeRegistrationVerification({
        phone: '13800138000',
        token: confirmed.verificationToken
      })
    ).to.deep.equal({ required: true, verified: true });

    let reused;
    try {
      await harness.service.consumeRegistrationVerification({
        phone: '13800138000',
        token: confirmed.verificationToken
      });
    } catch (error) {
      reused = error;
    }
    expect(reused.status).to.equal(403);
    expect(reused.code).to.equal('PHONE_VERIFICATION_REQUIRED');
  });

  it('binds a verification token to registration, login or password-reset purpose', async function() {
    const harness = createHarness();
    const challenge = await harness.service.requestChallenge({
      phone: '13800138000',
      purpose: 'login',
      ip: '203.0.113.8'
    });
    const confirmed = await harness.service.confirmChallenge({
      challengeId: challenge.challengeId,
      phone: '13800138000',
      purpose: 'login',
      code: '123456'
    });

    let registrationError;
    try {
      await harness.service.consumeRegistrationVerification({
        phone: '13800138000',
        token: confirmed.verificationToken
      });
    } catch (error) {
      registrationError = error;
    }
    expect(registrationError.code).to.equal('PHONE_VERIFICATION_REQUIRED');
    expect(
      await harness.service.consumeLoginVerification({
        phone: '13800138000',
        token: confirmed.verificationToken
      })
    ).to.deep.equal({ verified: true });

    const resetHarness = createHarness();
    const resetChallenge = await resetHarness.service.requestChallenge({
      phone: '13800138000',
      purpose: 'password-reset',
      ip: '203.0.113.8'
    });
    const resetConfirmation = await resetHarness.service.confirmChallenge({
      challengeId: resetChallenge.challengeId,
      phone: '13800138000',
      purpose: 'password-reset',
      code: '123456'
    });
    expect(
      await resetHarness.service.consumePasswordResetVerification({
        phone: '13800138000',
        token: resetConfirmation.verificationToken
      })
    ).to.deep.equal({ verified: true });
  });

  it('fails closed when verification is required but unconfigured', async function() {
    const harness = createHarness({ available: false, provider: null });
    let caught;
    try {
      await harness.service.consumeRegistrationVerification({
        phone: '13800138000',
        token: 'b'.repeat(64)
      });
    } catch (error) {
      caught = error;
    }

    expect(harness.service.getConfiguration()).to.include({
      available: false,
      requiredForPhoneRegistration: true
    });
    expect(caught.status).to.equal(503);
    expect(caught.code).to.equal('PHONE_VERIFICATION_NOT_CONFIGURED');
  });

  it('maps repository failures to a bounded unavailable error', async function() {
    const harness = createHarness({
      repositoryOverrides: {
        async consumeVerifiedToken() {
          throw new Error('database connection details');
        }
      }
    });
    let caught;
    try {
      await harness.service.consumeRegistrationVerification({
        phone: '13800138000',
        token: 'b'.repeat(64)
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).to.include({
      status: 503,
      code: 'PHONE_VERIFICATION_UNAVAILABLE',
      message: 'Phone verification is temporarily unavailable.'
    });
  });

  it('derives a different code hash for a different challenge', function() {
    const secret = 'test-phone-verification-secret-32-bytes-minimum';
    const phoneHash = 'c'.repeat(64);
    expect(hashCode(secret, 'a'.repeat(64), phoneHash, '123456')).not.to.equal(
      hashCode(secret, 'b'.repeat(64), phoneHash, '123456')
    );
  });
});

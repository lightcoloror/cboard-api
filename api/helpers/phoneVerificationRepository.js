'use strict';

function createPhoneVerificationRepository(Model) {
  if (!Model) throw new TypeError('Phone verification model is required');

  return {
    async create(record) {
      await Model.create(record);
    },

    async remove(challengeId) {
      await Model.deleteOne({ challengeId }).exec();
    },

    async setProviderRequestId(challengeId, providerRequestId) {
      if (!providerRequestId) return;
      await Model.updateOne(
        { challengeId },
        { $set: { providerRequestId } }
      ).exec();
    },

    async getActiveChallenge({ challengeId, phoneHash, purpose, now }) {
      return Model.findOne({
        challengeId,
        phoneHash,
        purpose,
        expiresAt: { $gt: now },
        consumedAt: null
      })
        .select('+codeHash')
        .lean()
        .exec();
    },

    async recordInvalidAttempt({
      challengeId,
      phoneHash,
      purpose,
      now,
      maxAttempts
    }) {
      return Model.findOneAndUpdate(
        {
          challengeId,
          phoneHash,
          purpose,
          expiresAt: { $gt: now },
          verifiedAt: null,
          consumedAt: null,
          attempts: { $lt: maxAttempts }
        },
        { $inc: { attempts: 1 } },
        { new: true }
      )
        .lean()
        .exec();
    },

    async markVerified({
      challengeId,
      phoneHash,
      purpose,
      codeHash,
      now,
      tokenHash,
      verificationExpiresAt,
      maxAttempts
    }) {
      return Model.findOneAndUpdate(
        {
          challengeId,
          phoneHash,
          purpose,
          codeHash,
          expiresAt: { $gt: now },
          verifiedAt: null,
          consumedAt: null,
          attempts: { $lt: maxAttempts }
        },
        {
          $set: {
            verifiedAt: now,
            verificationTokenHash: tokenHash,
            verificationExpiresAt,
            expiresAt: verificationExpiresAt
          },
          $unset: { codeHash: 1 }
        },
        { new: true }
      )
        .select('+verificationTokenHash')
        .lean()
        .exec();
    },

    async consumeVerifiedToken({ phoneHash, tokenHash, purpose, now }) {
      return Model.findOneAndUpdate(
        {
          phoneHash,
          verificationTokenHash: tokenHash,
          purpose,
          verifiedAt: { $ne: null },
          verificationExpiresAt: { $gt: now },
          consumedAt: null
        },
        { $set: { consumedAt: now } },
        { new: true }
      )
        .select('_id')
        .lean()
        .exec();
    }
  };
}

module.exports = {
  createPhoneVerificationRepository
};

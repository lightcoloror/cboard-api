'use strict';

const mongoose = require('mongoose');

const Schema = mongoose.Schema;

const phoneVerificationChallengeSchema = new Schema(
  {
    challengeId: {
      type: String,
      required: true,
      index: {
        name: 'challengeId_1',
        unique: true
      }
    },
    phoneHash: {
      type: String,
      required: true,
      index: {
        name: 'phoneHash_1'
      }
    },
    phoneMasked: {
      type: String,
      required: true
    },
    purpose: {
      type: String,
      enum: ['registration', 'login', 'password-reset'],
      default: 'registration',
      required: true
    },
    codeHash: {
      type: String,
      required: true,
      select: false
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0
    },
    verifiedAt: Date,
    verificationTokenHash: {
      type: String,
      select: false,
      index: {
        name: 'verificationTokenHash_1',
        unique: true,
        sparse: true
      }
    },
    verificationExpiresAt: Date,
    consumedAt: Date,
    provider: {
      type: String,
      required: true
    },
    providerRequestId: String,
    expiresAt: {
      type: Date,
      required: true,
      index: {
        name: 'expiresAt_1',
        expires: 0
      }
    }
  },
  {
    collection: 'phoneVerificationChallenges',
    timestamps: true
  }
);

module.exports = mongoose.model(
  'PhoneVerificationChallenge',
  phoneVerificationChallengeSchema
);

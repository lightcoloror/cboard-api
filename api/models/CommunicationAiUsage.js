'use strict';

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const communicationAiUsageSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    month: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}$/
    },
    provider: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64
    },
    model: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128
    },
    operation: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64
    },
    requestCount: {
      type: Number,
      min: 0,
      default: 0
    },
    reportedRequestCount: {
      type: Number,
      min: 0,
      default: 0
    },
    unreportedRequestCount: {
      type: Number,
      min: 0,
      default: 0
    },
    promptTokens: {
      type: Number,
      min: 0,
      default: 0
    },
    completionTokens: {
      type: Number,
      min: 0,
      default: 0
    },
    totalTokens: {
      type: Number,
      min: 0,
      default: 0
    },
    createdAt: {
      type: Number,
      required: true
    },
    updatedAt: {
      type: Number,
      required: true
    }
  },
  {
    toJSON: {
      versionKey: false,
      transform: function(doc, ret) {
        delete ret._id;
        delete ret.user;
      }
    }
  }
);

communicationAiUsageSchema.index(
  { user: 1, month: 1, provider: 1, model: 1, operation: 1 },
  {
    name: 'user_1_month_1_provider_1_model_1_operation_1',
    unique: true
  }
);

module.exports = mongoose.model(
  'CommunicationAiUsage',
  communicationAiUsageSchema
);

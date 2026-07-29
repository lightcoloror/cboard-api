'use strict';

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const communicationSavedPhraseSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    clientPhraseId: {
      type: String,
      required: true,
      trim: true
    },
    sentence: {
      type: String,
      default: '',
      trim: true
    },
    output: {
      type: Array,
      default: []
    },
    usageCount: {
      type: Number,
      min: 0,
      default: 0
    },
    contractVersion: {
      type: Number,
      min: 1,
      default: 1
    },
    createdAt: {
      type: Number,
      required: true
    },
    lastUsedAt: {
      type: Number,
      required: true
    },
    updatedAt: {
      type: Number,
      required: true
    },
    serverVersion: {
      type: Number,
      min: 1,
      default: 1
    },
    deletedAt: {
      type: Number,
      default: null
    },
    deletedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null
    }
  },
  {
    toJSON: {
      versionKey: false,
      transform: function(doc, ret) {
        ret.id = ret.clientPhraseId;
        delete ret._id;
        delete ret.clientPhraseId;
        delete ret.user;
      }
    }
  }
);

communicationSavedPhraseSchema.index(
  { user: 1, clientPhraseId: 1 },
  { name: 'user_1_clientPhraseId_1', unique: true }
);
communicationSavedPhraseSchema.index({ user: 1, updatedAt: -1 });

module.exports = mongoose.model(
  'CommunicationSavedPhrase',
  communicationSavedPhraseSchema
);

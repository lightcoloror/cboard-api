'use strict';

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const communicationReceiverPatientFeedbackEventSchema = new Schema(
  {
    type: {
      type: String,
      enum: [
        'understood',
        'not_understood',
        'repeat_requested'
      ],
      required: true
    },
    createdAt: {
      type: Number,
      required: true
    }
  },
  { _id: false }
);

const communicationReceiverRecordSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    clientRecordId: {
      type: String,
      required: true,
      trim: true
    },
    sessionId: {
      type: String,
      required: true,
      trim: true
    },
    patientId: {
      type: String,
      required: true,
      trim: true
    },
    workspaceId: {
      type: String,
      required: true,
      trim: true
    },
    direction: {
      type: String,
      enum: ['receive'],
      default: 'receive'
    },
    recordStatus: {
      type: String,
      enum: ['confirmed'],
      default: 'confirmed'
    },
    inputText: {
      type: String,
      required: true,
      trim: true
    },
    labels: {
      type: Array,
      default: []
    },
    pictogramSequence: {
      type: Array,
      default: []
    },
    contractVersion: {
      type: Number,
      default: 1
    },
    patientFeedback: {
      type: String,
      enum: [
        'understood',
        'not_understood',
        'repeat_requested'
      ]
    },
    patientFeedbackAt: {
      type: Number
    },
    patientFeedbackEvents: {
      type: [communicationReceiverPatientFeedbackEventSchema],
      default: []
    },
    createdAt: {
      type: Number,
      required: true
    },
    updatedAt: {
      type: Number,
      required: true
    },
    confirmedAt: {
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
        ret.id = ret.clientRecordId;
        delete ret._id;
        delete ret.clientRecordId;
        delete ret.user;
      }
    }
  }
);

communicationReceiverRecordSchema.index(
  { user: 1, clientRecordId: 1 },
  { name: 'user_1_clientRecordId_1', unique: true }
);
communicationReceiverRecordSchema.index({ user: 1, updatedAt: -1 });

module.exports = mongoose.model(
  'CommunicationReceiverRecord',
  communicationReceiverRecordSchema
);

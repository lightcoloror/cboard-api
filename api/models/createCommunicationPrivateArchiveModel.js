'use strict';

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

function createCommunicationPrivateArchiveModel(
  modelName,
  { formats = ['picinterpreter-picture-library'] } = {}
) {
  if (mongoose.models[modelName]) return mongoose.models[modelName];

  const schema = new Schema(
    {
      user: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
      },
      blobName: {
        type: String,
        required: true,
        select: false
      },
      format: {
        type: String,
        required: true,
        enum: formats
      },
      contractVersion: {
        type: Number,
        required: true,
        min: 1,
        default: 1
      },
      size: {
        type: Number,
        required: true,
        min: 1
      },
      sha256: {
        type: String,
        required: true,
        match: /^[a-f0-9]{64}$/
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
          delete ret.blobName;
        }
      }
    }
  );

  schema.index({ user: 1 }, { name: 'user_1', unique: true });
  return mongoose.model(modelName, schema);
}

module.exports = createCommunicationPrivateArchiveModel;

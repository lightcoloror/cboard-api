const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { createCareFamilyLifecycle } = require('../helpers/careFamilyLifecycle');

const lifecycleEnabled = () =>
  process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true';

const SETTINGS_SCHEMA_DEFINITION = {
  language: {},
  speech: {},
  display: {},
  scanning: {},
  navigation: {},
  communicationSupport: {},
  tuyujia: {},
  user: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
};

const SETTINGS_SCHEMA_OPTIONS = {
  toObject: {
    virtuals: true
  },
  toJSON: {
    virtuals: true,
    versionKey: false,
    transform: function(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
    }
  }
};

const settingsSchema = new Schema(
  SETTINGS_SCHEMA_DEFINITION,
  SETTINGS_SCHEMA_OPTIONS
);

settingsSchema.index({ user: 1 }, { name: 'user_1', unique: true });

settingsSchema.statics = {
  getOrCreate: async function(user) {
    if (!user || !user.id) {
      throw new Error('A user id is required to load settings');
    }

    const write = session => {
      const options = {
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        upsert: true,
        ...(session ? { session } : {})
      };
      return this.findOneAndUpdate(
        { user: user.id },
        { $setOnInsert: { user: user.id } },
        options
      ).exec();
    };
    const settings = lifecycleEnabled()
      ? await createCareFamilyLifecycle().withOpenAccount(String(user.id), write)
      : await write();

    return settings ? settings.toJSON() : null;
  }
};

const Settings = mongoose.model('Settings', settingsSchema);

module.exports = Settings;

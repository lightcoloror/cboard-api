const Settings = require('../models/Settings');
const { createCareFamilyLifecycle } = require('../helpers/careFamilyLifecycle');

const MUTABLE_SETTINGS_FIELDS = Object.freeze([
  'language',
  'speech',
  'display',
  'scanning',
  'navigation',
  'communicationSupport',
  'tuyujia'
]);

const lifecycleEnabled = () =>
  process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true';

function lifecycleResponse(error, res, fallbackMessage) {
  if (error && error.code === 'ACCOUNT_CLOSING') {
    return res.status(409).json({ message: 'Account is closing', error: { code: 'ACCOUNT_CLOSING' } });
  }
  if (error && error.code === 'ACCOUNT_CLOSED') {
    return res.status(403).json({ message: 'Account is closed', error: { code: 'ACCOUNT_CLOSED' } });
  }
  return res.status(500).json({ message: fallbackMessage, error: error.message });
}

module.exports = {
  updateSettings: updateSettings,
  getSettings: getSettings
};

async function updateSettings(req, res) {
  if (!req.user) {
    return res
      .status(400)
      .json({ message: 'Are you logged in? Is bearer token present?' });
  }

  const { body } = req;
  if (process.env.CARE_NEXT_ENABLED === 'true' && body && (body.communicationSupport || body.tuyujia)) {
    return res.status(409).json({ code: 'USE_PATIENT_SYNC', message: 'Use the scoped patient sync endpoints for communication content.' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({
      message: 'Settings must be an object'
    });
  }

  const patch = MUTABLE_SETTINGS_FIELDS.reduce((result, field) => {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      result[field] = body[field];
    }
    return result;
  }, {});

  try {
    const write = session => Settings.findOneAndUpdate(
      { user: req.user.id },
      {
        $set: patch,
        $setOnInsert: { user: req.user.id }
      },
      {
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        upsert: true,
        ...(session ? { session } : {})
      }
    ).exec();
    const settings = lifecycleEnabled()
      ? await createCareFamilyLifecycle().withOpenAccount(String(req.user.id), write)
      : await write();
    if (!settings) {
      throw new Error('Settings update returned no record');
    }
    return res.status(200).json(settings.toJSON());
  } catch (err) {
    if (err && (err.code === 'ACCOUNT_CLOSING' || err.code === 'ACCOUNT_CLOSED')) {
      return lifecycleResponse(err, res, 'Error saving settings');
    }
    return res.status(409).json({ message: 'Error saving settings', error: err.message });
  }
}

async function getSettings(req, res) {
  if (!req.user) {
    return res
      .status(400)
      .json({ message: 'Are you logged in? Is bearer token present?' });
  }

  try {
    const response = await Settings.getOrCreate(req.user);
    if (!response) {
      throw new Error('Settings lookup returned no record');
    }
    return res.status(200).json(response);
  } catch (err) {
    if (err && (err.code === 'ACCOUNT_CLOSING' || err.code === 'ACCOUNT_CLOSED')) {
      return lifecycleResponse(err, res, 'Error loading settings');
    }
    return res.status(500).json({ message: 'Error loading settings', error: err.message });
  }
}

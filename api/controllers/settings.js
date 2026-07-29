const Settings = require('../models/Settings');

const MUTABLE_SETTINGS_FIELDS = Object.freeze([
  'language',
  'speech',
  'display',
  'scanning',
  'navigation',
  'communicationSupport',
  'tuyujia'
]);

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
    const settings = await Settings.findOneAndUpdate(
      { user: req.user.id },
      {
        $set: patch,
        $setOnInsert: { user: req.user.id }
      },
      {
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        upsert: true
      }
    ).exec();
    if (!settings) {
      throw new Error('Settings update returned no record');
    }
    return res.status(200).json(settings.toJSON());
  } catch (err) {
    return res.status(409).json({
      message: 'Error saving settings',
      error: err.message
    });
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
    return res.status(500).json({
      message: 'Error loading settings',
      error: err.message
    });
  }
}

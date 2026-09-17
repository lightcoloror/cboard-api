'use strict';

function featureEnabled(env = process.env) {
  return env.CARE_COLLABORATION_ENABLED === 'true' &&
    env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true';
}

function publicError(error) {
  const status = Number(error && (error.status || error.statusCode));
  return {
    status: Number.isInteger(status) && status >= 400 && status < 600 ? status : 503,
    code: error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : 'CLOSURE_PREVIEW_UNAVAILABLE'
  };
}

function createCareClosureController({
  coordinator = null,
  enabled = () => featureEnabled()
} = {}) {
  let activeCoordinator = coordinator;
  const isEnabled = typeof enabled === 'function' ? enabled : () => enabled === true;
  return async function previewClosure(req, res) {
    res.set('Cache-Control', 'no-store');
    if (!req.user || !req.user.id) {
      return res.status(401).json({ code: 'LOGIN_REQUIRED' });
    }
    if (!isEnabled()) {
      return res.status(503).json({ code: 'CARE_CLOSURE_DISABLED' });
    }
    try {
      if (!activeCoordinator) {
        activeCoordinator = require('../helpers/careClosureCoordinator').createCareClosureCoordinator();
      }
      const result = await activeCoordinator.preview(String(req.user.id));
      return res.status(200).json(result);
    } catch (error) {
      const safe = publicError(error);
      return res.status(safe.status).json({ code: safe.code });
    }
  };
}

module.exports = {
  createCareClosureController,
  featureEnabled,
  previewClosure: createCareClosureController()
};

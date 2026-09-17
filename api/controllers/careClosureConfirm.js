'use strict';

function featureEnabled(env = process.env) {
  return env.CARE_COLLABORATION_ENABLED === 'true' &&
    env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true' &&
    env.CARE_CLOSURE_CONFIRMATION_ENABLED === 'true';
}

function validId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) &&
    !['__proto__', 'constructor', 'prototype'].includes(value);
}

function validSecret(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function publicError(error, fallbackCode) {
  const status = Number(error && (error.status || error.statusCode));
  return {
    status: Number.isInteger(status) && status >= 400 && status < 600 ? status : 503,
    code: error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : fallbackCode
  };
}

function createCareClosureConfirmController({
  coordinator = null,
  receipt = null,
  consumeLimits = null,
  enabled = () => featureEnabled()
} = {}) {
  let activeCoordinator = coordinator;
  let activeReceipt = receipt;
  let activeConsumeLimits = consumeLimits;
  let getLimiters;

  function limiterDependencies(operation) {
    if (!activeConsumeLimits) {
      const rateLimitModule = require('../helpers/authRequestRateLimit');
      activeConsumeLimits = rateLimitModule.consumeAuthRequestLimits;
      getLimiters = rateLimitModule.getAuthRequestLimiters;
    } else if (!getLimiters) {
      getLimiters = () => undefined;
    }
    return { limiters: getLimiters(operation), consume: activeConsumeLimits };
  }

  function ensureCoordinator() {
    if (!activeCoordinator) {
      const receiptModule = require('../helpers/careClosureReceipt');
      const coordinatorModule = require('../helpers/careClosureCoordinator');
      if (!activeReceipt) activeReceipt = receiptModule.createCareClosureReceipt();
      activeCoordinator = coordinatorModule.createCareClosureCoordinator({ receipt: activeReceipt });
    }
    return activeCoordinator;
  }

  function enabledNow() {
    return typeof enabled === 'function' ? enabled() : enabled === true;
  }

  function respondError(res, error) {
    const safe = publicError(error, 'CLOSURE_CONFIRMATION_UNAVAILABLE');
    if (error && error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    return res.status(safe.status).json({ code: safe.code });
  }

  async function confirmClosure(req, res) {
    res.set('Cache-Control', 'no-store');
    if (!req.user || !req.user.id) return res.status(401).json({ code: 'LOGIN_REQUIRED' });
    if (!enabledNow()) return res.status(503).json({ code: 'CARE_CLOSURE_DISABLED' });
    const body = req.body;
    const familyIds = body && body.familyIds;
    const owner = String(req.user.id);
    try {
      const deps = limiterDependencies('closureConfirm');
      await deps.consume({ limiters: deps.limiters, operation: 'closureConfirm', email: owner, ip: req.ip });
    } catch (error) {
      return respondError(res, error);
    }
    if (!body || body.confirmCloudDeletion !== true) {
      return res.status(400).json({ code: 'CLOSURE_CONFIRMATION_REQUIRED' });
    }
    const strictBody = body && typeof body === 'object' && !Array.isArray(body) &&
      Object.keys(body).length === 3 &&
      Object.prototype.hasOwnProperty.call(body, 'familyIds') &&
      Object.prototype.hasOwnProperty.call(body, 'secret') &&
      Object.prototype.hasOwnProperty.call(body, 'confirmCloudDeletion');
    if (!strictBody || !Array.isArray(familyIds) || familyIds.length > 1000 ||
        familyIds.some(id => !validId(id)) || new Set(familyIds).size !== familyIds.length ||
        !validSecret(body.secret)) {
      return res.status(400).json({ code: 'CLOSURE_CONFIRMATION_INVALID' });
    }
    try {
      const result = await ensureCoordinator().begin(owner, familyIds, body.secret);
      return res.status(202).json({
        operationId: result.operationId,
        cleanupStatus: result.cleanupStatus,
        accountDeleted: false
      });
    } catch (error) {
      return respondError(res, error);
    }
  }

  return { confirmClosure };
}

const controller = createCareClosureConfirmController();

module.exports = {
  createCareClosureConfirmController,
  featureEnabled,
  confirmClosure: controller.confirmClosure
};

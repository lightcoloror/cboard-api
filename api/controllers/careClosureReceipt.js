'use strict';

function featureEnabled(env = process.env) {
  return env.CARE_COLLABORATION_ENABLED === 'true' &&
    env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true';
}

function validReceiptId(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
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

function createCareClosureReceiptController({
  receipt = null,
  consumeLimits = null,
  enabled = () => featureEnabled()
} = {}) {
  let activeReceipt = receipt;
  let activeConsumeLimits = consumeLimits;
  let getLimiters;

  function dependencies(operation) {
    if (!activeReceipt) {
      const receiptModule = require('../helpers/careClosureReceipt');
      activeReceipt = receiptModule.createCareClosureReceipt();
    }
    if (!activeConsumeLimits) {
      const rateLimitModule = require('../helpers/authRequestRateLimit');
      activeConsumeLimits = rateLimitModule.consumeAuthRequestLimits;
      getLimiters = rateLimitModule.getAuthRequestLimiters;
    } else if (!getLimiters) {
      // A test or embedding caller that supplies the complete consume adapter
      // does not need the default Mongo limiter construction.
      getLimiters = () => undefined;
    }
    return { limiters: getLimiters(operation), consume: activeConsumeLimits };
  }

  async function consume(operation, email, ip) {
    const deps = dependencies(operation);
    return deps.consume({ limiters: deps.limiters, operation, email, ip });
  }

  function enabledNow() {
    return typeof enabled === 'function' ? enabled() : enabled === true;
  }

  function respondError(res, error, fallbackCode) {
    const safe = publicError(error, fallbackCode);
    if (error && error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    return res.status(safe.status).json({ code: safe.code });
  }

  async function prepareClosureReceipt(req, res) {
    res.set('Cache-Control', 'no-store');
    if (!req.user || !req.user.id) return res.status(401).json({ code: 'LOGIN_REQUIRED' });
    if (!enabledNow()) return res.status(503).json({ code: 'CARE_CLOSURE_DISABLED' });
    try {
      const owner = String(req.user.id);
      await consume('closurePrepare', owner, req.ip);
      const result = await activeReceipt.prepare(owner);
      return res.status(201).json(result);
    } catch (error) {
      return respondError(res, error, 'CLOSURE_RECEIPT_UNAVAILABLE');
    }
  }

  async function inspectClosureReceipt(req, res) {
    res.set('Cache-Control', 'no-store');
    if (!enabledNow()) return res.status(503).json({ code: 'CARE_CLOSURE_DISABLED' });
    const body = req.body || {};
    const receiptId = body.receiptId;
    const secret = body.secret;
    try {
      // Consume before validating the capability so malformed probes are also
      // covered by the shared authentication limiter.
      await consume('closureStatus', receiptId, req.ip);
      const onlyCapabilityFields = body && typeof body === 'object' && !Array.isArray(body) &&
        Object.keys(body).length === 2 &&
        Object.prototype.hasOwnProperty.call(body, 'receiptId') &&
        Object.prototype.hasOwnProperty.call(body, 'secret');
      if (!onlyCapabilityFields || !validReceiptId(receiptId) || !validSecret(secret)) {
        return res.status(404).json({ code: 'CLOSURE_RECEIPT_UNAVAILABLE' });
      }
      const result = await activeReceipt.inspect(receiptId, secret);
      return res.status(200).json(result);
    } catch (error) {
      return respondError(res, error, 'CLOSURE_RECEIPT_UNAVAILABLE');
    }
  }

  return { prepareClosureReceipt, inspectClosureReceipt };
}

const controller = createCareClosureReceiptController();

module.exports = {
  createCareClosureReceiptController,
  featureEnabled,
  prepareClosureReceipt: controller.prepareClosureReceipt,
  inspectClosureReceipt: controller.inspectClosureReceipt
};

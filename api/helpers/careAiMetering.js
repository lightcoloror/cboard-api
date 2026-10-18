'use strict';
const crypto = require('crypto');
const { fail } = require('./carePolicy');
const { normalizeResegmentResponse } = require('./resegmentationContract');
const REPLAYABLE_OPERATIONS = new Set(['generateCommunicationSentences', 'resegmentCommunicationText']);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonical(value[key]);
    return result;
  }, Object.create(null));
  return value;
}

function replayableResponse(operation, status, body) {
  if (status >= 400) {
    const code = body && (body.code || body.error && body.error.code);
    return { status, body: { error: {
      code: typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'COMMUNICATION_AI_REQUEST_FAILED',
      message: 'Communication AI request failed'
    } } };
  }
  if (operation === 'resegmentCommunicationText') {
    const normalized = normalizeResegmentResponse(body && body.sourceText, body);
    if (!normalized) fail(503, 'AI_RESPONSE_NOT_PERSISTABLE');
    return { status, body: { ...normalized, provider: 'cboard-api-ai' } };
  }
  if (!body || !Array.isArray(body.candidates) || !body.candidates.length || body.candidates.length > 5 ||
      body.candidates.some(text => typeof text !== 'string' || !text.length || Array.from(text).length > 120)) fail(503, 'AI_RESPONSE_NOT_PERSISTABLE');
  return { status, body: { candidates: body.candidates.slice(), provider: 'cboard-api-ai', isOfflineFallback: false } };
}
const OPERATIONS = new Set([
  'editPhrase', 'generateCommunicationSentences', 'resegmentCommunicationText',
  'synthesizeCommunicationSpeech', 'normalizeCommunicationDialectText',
  'recognizeCommunicationDialectAudio', 'recognizeCommunicationImageText',
  'suggestCommunicationPictogramMetadata', 'generateCommunicationPictogram', 'removeCommunicationImageBackground'
]);

function validPrice(price) {
  return Boolean(price) &&
    Number.isSafeInteger(price.reservationUnits) && price.reservationUnits >= 1 &&
    Number.isSafeInteger(price.fixedUnits) && price.fixedUnits >= 0 &&
    price.fixedUnits <= price.reservationUnits &&
    (price.tokensPerUnit === undefined ||
      (Number.isSafeInteger(price.tokensPerUnit) && price.tokensPerUnit >= 1));
}

function validateCareAiPricePolicy(prices, operation) {
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) return false;
  if (operation !== undefined) return validPrice(prices[operation]);
  return [...OPERATIONS].every(name => validPrice(prices[name]));
}

function createCareAiMetering({ env = process.env, runtimeFactory, authorizeProfile } = {}) {
  return async (req, res, next) => {
    const operation = req.swagger && req.swagger.operation && req.swagger.operation.operationId;
    if (!OPERATIONS.has(operation)) return next();
    // Public trial must never silently fall back to legacy account billing.
    if (env.CARE_PUBLIC_TRIAL_ENABLED === 'true' && env.CARE_NEXT_ENABLED !== 'true') {
      res.set('Cache-Control', 'no-store');
      return res.status(503).json({ code: 'CARE_TRIAL_CONFIGURATION_INVALID' });
    }
    if (env.CARE_NEXT_ENABLED !== 'true') {
      const headers = req.headers || {};
      const carriesCareIntent = headers['x-care-profile-id'] || headers['x-care-funding-id'] ||
        typeof headers['idempotency-key'] === 'string' && headers['idempotency-key'].startsWith('cai_');
      if (REPLAYABLE_OPERATIONS.has(operation) && carriesCareIntent) {
        // A new client must not fall through to legacy billing if the server
        // loses its Care switch; legacy billing does not share these receipts.
        res.set('Cache-Control', 'no-store');
        return res.status(503).json({ code: 'CARE_TRIAL_CONFIGURATION_INVALID' });
      }
      return next();
    }
    try {
      if (!req.user) fail(401, 'LOGIN_REQUIRED');
      const actor = String(req.user.id);
      const fundingId = req.headers['x-care-funding-id'];
      const profileId = req.headers['x-care-profile-id'];
      const requestId = req.headers['idempotency-key'];
      if (!fundingId || !profileId || !requestId) fail(400, 'EXPLICIT_FUNDING_REQUIRED');
      let prices;
      try { prices = JSON.parse(env.CARE_AI_PRICE_POLICY || '{}'); } catch (_) { fail(503, 'AI_PRICE_POLICY_INVALID'); }
      if (!validateCareAiPricePolicy(prices, operation)) fail(503, 'AI_PRICE_POLICY_NOT_CONFIGURED');
      const price = prices[operation];
      const runtime = require('./careBudgetRuntime');
      await (authorizeProfile || runtime.authorizeProfile)(actor, profileId, fundingId, true);
      const service = (runtimeFactory || runtime.createRuntime)();
      const fingerprintInput = { operation, body: req.body || {}, price };
      // New clients hash canonical JSON. Preserve historical ID fingerprinting
      // so old receipts keep their original duplicate/conflict semantics.
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(
        typeof requestId === 'string' && /^cai_[a-f0-9]{64}$/.test(requestId)
          ? canonical(fingerprintInput) : fingerprintInput
      )).digest('hex');
      const reservation = await service.reserve(fundingId, { actor, profileId, requestId, units: price.reservationUnits, fingerprint });
      res.set('Cache-Control', 'no-store, private');
      res.set('X-Care-Usage-Request', requestId);
      if (reservation.duplicate) {
        if (REPLAYABLE_OPERATIONS.has(operation) && reservation.response && reservation.status !== 'reserved') {
          // Authorization above and reserve's grant check still run on every replay.
          res.set('X-Care-Idempotency-Replayed', 'true');
          res.set('X-Care-Usage-State', 'completed');
          return res.status(reservation.response.status).json(reservation.response.body);
        }
        res.set('X-Care-Usage-State', reservation.status === 'reserved' ? 'pending' : 'completed');
        fail(409, reservation.status === 'reserved' ? 'AI_REQUEST_PENDING_RECONCILIATION' : 'AI_REQUEST_ALREADY_COMPLETED');
      }
      let observedUnits = null;
      let providerStarted = false;
      let responseBeingSaved = false;
      const replayable = REPLAYABLE_OPERATIONS.has(operation);
      req.careUsage = {
        markProviderStarted() { providerStarted = true; },
        async observe(usage) {
          // The normalizer returns zero even when the provider omitted usage.
          // Only an explicit valid report resolves an uncertain reservation.
          if (usage && usage.reported === true && Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= 0) {
            observedUnits = price.tokensPerUnit
              ? Math.max(price.fixedUnits, Math.ceil(usage.totalTokens / price.tokensPerUnit))
              : price.fixedUnits;
          }
        },
        // Controllers can release only a definitively unexecuted request. A lost
        // connection or provider timeout alone must never be treated as proof.
        releaseUnexecuted: () => service.settle(fundingId, actor, requestId, 0)
      };
      if (replayable) {
        const sendJson = res.json.bind(res);
        res.json = body => {
          if (responseBeingSaved) return res;
          responseBeingSaved = true;
          const status = res.statusCode;
          const actual = status < 400 || observedUnits !== null
            ? observedUnits === null ? price.fixedUnits : observedUnits
            : !providerStarted || [400, 401, 403, 413, 415, 422, 429].includes(status) ? 0 : null;
          if (actual === null) {
            res.set('X-Care-Usage-State', 'pending');
            // An upstream timeout is not evidence of non-execution. Its receipt
            // remains reserved and is never retried by calling next() again.
            sendJson(body);
            return res;
          }
          Promise.resolve().then(async () => {
            const response = replayableResponse(operation, status, body);
            await service.complete(fundingId, actor, requestId, actual, response);
            if (!res.destroyed) {
              res.set('X-Care-Usage-State', 'completed');
              res.status(response.status);
              sendJson(response.body);
            }
          }).catch(() => {
            // The reservation is the durable stop on repeated provider calls,
            // even if storage failed before or after a successful CAS write.
            if (!res.destroyed && !res.headersSent) {
              res.set('X-Care-Usage-State', 'pending');
              res.status(503);
              sendJson({ code: 'AI_RESPONSE_PERSISTENCE_UNAVAILABLE' });
            }
          });
          return res;
        };
      }
      res.once('finish', () => {
        if (responseBeingSaved) return;
        // A complete provider response can still fail source-preservation or
        // other business validation. Its known usage must settle nevertheless.
        if (res.statusCode < 400 || observedUnits !== null) {
          service.settle(fundingId, actor, requestId, observedUnits === null ? price.fixedUnits : observedUnits)
            .catch(() => { /* Durable reservation remains available for reconciliation. */ });
        } else if (!providerStarted || [400, 401, 403, 413, 415, 422, 429].includes(res.statusCode)) service.settle(fundingId, actor, requestId, 0).catch(() => {});
      });
      res.once('close', () => { if (!responseBeingSaved && !providerStarted && !res.writableFinished) service.settle(fundingId, actor, requestId, 0).catch(() => {}); });
      return next();
    } catch (e) {
      return res.status(e.status || 503).json({ code: e.code || 'FUNDING_UNAVAILABLE' });
    }
  };
}
module.exports = { createCareAiMetering, OPERATIONS, validateCareAiPricePolicy };

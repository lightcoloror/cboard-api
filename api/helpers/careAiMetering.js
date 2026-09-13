'use strict';
const crypto = require('crypto');
const { fail } = require('./carePolicy');
const OPERATIONS = new Set([
  'editPhrase', 'generateCommunicationSentences', 'resegmentCommunicationText',
  'synthesizeCommunicationSpeech', 'normalizeCommunicationDialectText',
  'recognizeCommunicationDialectAudio', 'recognizeCommunicationImageText',
  'suggestCommunicationPictogramMetadata', 'generateCommunicationPictogram', 'removeCommunicationImageBackground'
]);
function createCareAiMetering({ env = process.env, runtimeFactory, authorizeProfile } = {}) {
  return async (req, res, next) => {
    const operation = req.swagger && req.swagger.operation && req.swagger.operation.operationId;
    if (env.CARE_NEXT_ENABLED !== 'true' || !OPERATIONS.has(operation)) return next();
    try {
      if (!req.user) fail(401, 'LOGIN_REQUIRED');
      const actor = String(req.user.id);
      const fundingId = req.headers['x-care-funding-id'];
      const profileId = req.headers['x-care-profile-id'];
      const requestId = req.headers['idempotency-key'];
      if (!fundingId || !profileId || !requestId) fail(400, 'EXPLICIT_FUNDING_REQUIRED');
      let prices;
      try { prices = JSON.parse(env.CARE_AI_PRICE_POLICY || '{}'); } catch (_) { fail(503, 'AI_PRICE_POLICY_INVALID'); }
      const price = prices[operation];
      if (!price || !Number.isSafeInteger(price.reservationUnits) || price.reservationUnits < 1 ||
          !Number.isSafeInteger(price.fixedUnits) || price.fixedUnits < 0 || price.fixedUnits > price.reservationUnits ||
          (price.tokensPerUnit !== undefined && (!Number.isSafeInteger(price.tokensPerUnit) || price.tokensPerUnit < 1))) fail(503, 'AI_PRICE_POLICY_NOT_CONFIGURED');
      const runtime = require('./careBudgetRuntime');
      await (authorizeProfile || runtime.authorizeProfile)(actor, profileId, fundingId, true);
      const service = (runtimeFactory || runtime.createRuntime)();
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ operation, body: req.body || {}, price })).digest('hex');
      const reservation = await service.reserve(fundingId, { actor, profileId, requestId, units: price.reservationUnits, fingerprint });
      if (reservation.duplicate) fail(409, reservation.status === 'reserved' ? 'AI_REQUEST_PENDING_RECONCILIATION' : 'AI_REQUEST_ALREADY_COMPLETED');
      let observedUnits = null;
      let providerStarted = false;
      req.careUsage = {
        markProviderStarted() { providerStarted = true; },
        async observe(usage) {
          if (price.tokensPerUnit && usage && Number.isFinite(Number(usage.totalTokens))) {
            observedUnits = Math.max(price.fixedUnits, Math.ceil(Number(usage.totalTokens) / price.tokensPerUnit));
          }
        },
        // Controllers can release only a definitively unexecuted request. A lost
        // connection or provider timeout alone must never be treated as proof.
        releaseUnexecuted: () => service.settle(fundingId, actor, requestId, 0)
      };
      res.once('finish', () => {
        if (res.statusCode < 400) {
          service.settle(fundingId, actor, requestId, observedUnits === null ? price.fixedUnits : observedUnits)
            .catch(() => { /* Durable reservation remains available for reconciliation. */ });
        } else if (!providerStarted || [400, 401, 403, 413, 415, 422, 429].includes(res.statusCode)) service.settle(fundingId, actor, requestId, 0).catch(() => {});
      });
      res.once('close', () => { if (!providerStarted && !res.writableFinished) service.settle(fundingId, actor, requestId, 0).catch(() => {}); });
      res.set('X-Care-Usage-Request', requestId);
      return next();
    } catch (e) {
      return res.status(e.status || 503).json({ code: e.code || 'FUNDING_UNAVAILABLE' });
    }
  };
}
module.exports = { createCareAiMetering, OPERATIONS };

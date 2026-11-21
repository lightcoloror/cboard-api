'use strict';

const crypto = require('crypto');
const express = require('express');
const { hashRateLimitIdentity, isLimiterRejection } = require('./authRequestRateLimit');
const {
  decomposeConceptToMulberryParts,
  loadCleanMulberrySvg,
  loadMulberryPartIndex,
  searchMulberryParts
} = require('./mulberryPartIndex');
const {
  composeMissingPictogram,
  sanitizeCompositionLabel
} = require('./pictogramComposer');
const { DEFAULT_ALLOWED_ORIGINS } = require('./pictogramCompositionRuntime');

const PART_ID_RE = /^[a-zA-Z0-9_,-]{1,120}$/;
const DEV_SCOPE_ID_RE = /^[a-zA-Z0-9:_-]{1,64}$/;
const ALLOWED_CONFIRM_MIME_TYPES = new Set([
  'image/png',
  'image/gif',
  'image/webp',
  'image/jpeg'
]);
const SAFE_CLIENT_ERROR_STATUSES = new Set([400, 401, 403, 404, 409, 413, 415, 422, 429, 501, 503]);

function createRouterError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function deriveUserScopeId(user) {
  const rawId = user && (user.id || user._id);
  const cleanId = String(rawId || '').trim();
  if (!cleanId) {
    throw createRouterError('LOGIN_REQUIRED', 'Authenticated user id is required', 401);
  }
  return (
    'user:' +
    crypto
      .createHash('sha256')
      .update(cleanId)
      .digest('hex')
      .slice(0, 24)
  );
}

function sendRouterError(res, error, fallbackCode = 'PICTOGRAM_COMPOSITION_ERROR') {
  const status = Number(error && error.status);
  if (SAFE_CLIENT_ERROR_STATUSES.has(status)) {
    return res.status(status).json({
      error: {
        code: (error && error.code) || fallbackCode,
        message: error && error.message ? error.message : 'Request failed'
      }
    });
  }
  return res.status(500).json({
    error: {
      code: fallbackCode,
      message: 'Pictogram composition request failed'
    }
  });
}

function clampSearchLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 8;
  return Math.max(1, Math.min(20, Math.round(parsed)));
}

function createPictogramCompositionRouter({
  pipeline,
  cache = null,
  enabled = false,
  authenticate = null,
  requireAuth = true,
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
  limiter = null,
  allowClientScopeInDev = false,
  maxJsonBytes = '2mb',
  isTier2Configured = false,
  isRecipePlannerConfigured = false,
  embedQuery = null,
  isBgeRuntimeReady = Boolean(embedQuery)
} = {}) {
  if (!pipeline || typeof pipeline.resolveMissingPictogram !== 'function') {
    throw new Error('pipeline with resolveMissingPictogram is required');
  }

  const router = express.Router();
  const originWhitelist = Array.isArray(allowedOrigins) ? allowedOrigins : [];

  router.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');

    const isEnabled = typeof enabled === 'function' ? Boolean(enabled()) : Boolean(enabled);
    if (!isEnabled) {
      return res.status(503).json({
        error: {
          code: 'PICTOGRAM_COMPOSITION_NOT_ENABLED',
          message: 'Pictogram composition v2 is disabled'
        }
      });
    }

    const origin = req.get('Origin');
    if (origin && !originWhitelist.includes(origin)) {
      return res.status(403).json({
        error: {
          code: 'ORIGIN_NOT_ALLOWED',
          message: 'Origin not allowed'
        }
      });
    }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.vary('Origin');
    }
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      return res.sendStatus(204);
    }

    return next();
  });

  router.use(express.json({ limit: maxJsonBytes, strict: true }));

  async function enforceAuthAndScope(req) {
    if (requireAuth !== false) {
      const header = req.get('Authorization') || '';
      if (
        !authenticate ||
        !/^Bearer [^\s]+$/.test(header) ||
        !(await authenticate(req, header)) ||
        !req.user ||
        !(req.user.id || req.user._id)
      ) {
        throw createRouterError('LOGIN_REQUIRED', 'Authentication required', 401);
      }
      req.pictogramScopeId = deriveUserScopeId(req.user);
      return;
    }

    const requestedScope = allowClientScopeInDev
      ? String((req.body && req.body.scopeId) || (req.query && req.query.scopeId) || '').trim()
      : '';
    req.pictogramScopeId = DEV_SCOPE_ID_RE.test(requestedScope)
      ? requestedScope
      : 'local-workbench';
  }

  async function enforceRateLimit(req, res) {
    if (!limiter || typeof limiter.consume !== 'function') return;
    const identity = (req.user && (req.user.id || req.user._id)) || req.ip || 'unknown';
    try {
      await limiter.consume(hashRateLimitIdentity(`pictogram-v2:${identity}`), 1);
    } catch (error) {
      if (isLimiterRejection(error)) {
        res.set('Retry-After', String(Math.max(1, Math.ceil(Number(error.msBeforeNext) / 1000))));
        throw createRouterError('PICTOGRAM_RATE_LIMITED', 'Too many pictogram composition requests', 429);
      }
      throw createRouterError('PICTOGRAM_RATE_LIMIT_UNAVAILABLE', 'Rate limiter unavailable', 503);
    }
  }

  function withProtection(handler, { requireJson = false } = {}) {
    return async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        if (requireJson && !req.is('application/json')) {
          throw createRouterError('JSON_REQUIRED', 'Content-Type application/json is required', 415);
        }
        await enforceAuthAndScope(req);
        await enforceRateLimit(req, res);
        await handler(req, res);
      } catch (error) {
        sendRouterError(res, error);
      }
    };
  }

  router.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      enabled: true,
      tier1Ready: true,
      tier2Configured: Boolean(isTier2Configured),
      recipePlannerConfigured: Boolean(isRecipePlannerConfigured),
      bgeRuntimeReady: Boolean(isBgeRuntimeReady),
      cacheReady: Boolean(cache),
      partCount: loadMulberryPartIndex().parts.length
    });
  });

  router.get('/parts/search', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const query = String(req.query && req.query.q ? req.query.q : '').trim().slice(0, 40);
    if (!query) {
      return res.status(400).json({
        error: {
          code: 'INVALID_QUERY',
          message: 'Query parameter q (1-40 chars) is required'
        }
      });
    }
    const limit = clampSearchLimit(req.query && req.query.limit);
    const includeSuspect = String(req.query && req.query.includeSuspect) === 'true';

    let queryVector = null;
    if (typeof embedQuery === 'function') {
      try {
        queryVector = await embedQuery(query);
      } catch (_) {
        queryVector = null;
      }
    }

    const results = searchMulberryParts(query, { limit, includeSuspect, queryVector });
    const decomposition = decomposeConceptToMulberryParts(query);
    return res.status(200).json({
      query,
      bgeUsed: Boolean(queryVector),
      results,
      decomposition
    });
  });

  router.get('/parts/:partId/svg', (req, res) => {
    const rawPartId = String(req.params && req.params.partId ? req.params.partId : '').trim();
    const partId = rawPartId.endsWith('.svg') ? rawPartId.slice(0, -4) : rawPartId;
    if (!PART_ID_RE.test(partId)) {
      return res.status(400).json({
        error: {
          code: 'INVALID_PART_ID',
          message: 'Invalid Mulberry partId'
        }
      });
    }

    const svg = loadCleanMulberrySvg(partId);
    if (!svg) {
      return res.status(404).json({
        error: {
          code: 'PART_NOT_FOUND',
          message: 'Mulberry part SVG not found'
        }
      });
    }

    res.set('Content-Type', 'image/svg+xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    return res.status(200).send(svg);
  });

  router.post(
    '/compose',
    withProtection(
      async (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const label = sanitizeCompositionLabel(typeof body.label === 'string' ? body.label : '');
        if (!label) {
          throw createRouterError('INVALID_LABEL', 'label is required (1-24 chars)', 400);
        }

        const preferStatic = Boolean(body.preferStatic);
        const includeLabel = body.includeLabel !== false;
        const requestedFormat =
          typeof body.format === 'string' && ['svg', 'png', 'gif', 'all'].includes(body.format.toLowerCase())
            ? body.format.toLowerCase()
            : 'all';

        const composed = await composeMissingPictogram(label, {
          format: requestedFormat,
          includeLabel
        });

        const pngBase64 = composed.pngBuffer ? composed.pngBuffer.toString('base64') : null;
        const gifBase64 = composed.gifBuffer ? composed.gifBuffer.toString('base64') : null;
        const useGif = !preferStatic && Boolean(gifBase64);
        const primaryMime = useGif ? 'image/gif' : pngBase64 ? 'image/png' : 'image/svg+xml';
        const primaryMediaType = useGif ? 'gif' : pngBase64 ? 'image' : 'svg';
        const primaryImageBase64 = useGif ? gifBase64 : pngBase64;

        return res.status(200).json({
          status: 'composed',
          tier: 'tier1_mulberry',
          label: composed.recipe.label,
          recipe: composed.recipe,
          mimeType: primaryMime,
          mediaType: primaryMediaType,
          imageBase64: primaryImageBase64,
          svg: composed.svg || null,
          pngBase64,
          gifBase64,
          license: composed.recipe.license,
          attribution: composed.recipe.attribution,
          metrics: composed.metrics
        });
      },
      { requireJson: true }
    )
  );

  router.post(
    '/resolve',
    withProtection(
      async (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const label = sanitizeCompositionLabel(typeof body.label === 'string' ? body.label : '');
        if (!label) {
          throw createRouterError('INVALID_LABEL', 'label is required (1-24 chars)', 400);
        }

        const result = await pipeline.resolveMissingPictogram(
          {
            label,
            scopeId: req.pictogramScopeId,
            forceRefinement: Boolean(body.forceRefinement),
            forceRecipePlanner: Boolean(body.forceRecipePlanner),
            bypassCache: Boolean(body.bypassCache),
            isAnimatedAction: typeof body.isAnimatedAction === 'boolean' ? body.isAnimatedAction : undefined,
            includeLabel: body.includeLabel !== false,
            regenHint: typeof body.regenHint === 'string' ? body.regenHint : undefined,
            allowedSynonyms: Array.isArray(body.allowedSynonyms) ? body.allowedSynonyms : undefined,
            forbiddenConfusions: Array.isArray(body.forbiddenConfusions) ? body.forbiddenConfusions : undefined,
            registeredPersonNames: Array.isArray(body.registeredPersonNames) ? body.registeredPersonNames : undefined,
            containsPersonalPhoto: Boolean(body.containsPersonalPhoto),
            hasRealPersonAvatar: Boolean(body.hasRealPersonAvatar),
            devicePrivatePhoto: Boolean(body.devicePrivatePhoto)
          },
          { userId: req.user && (req.user.id || req.user._id) ? String(req.user.id || req.user._id) : req.pictogramScopeId }
        );

        return res.status(200).json({
          status: result.status,
          tier: result.tier,
          cacheHit: Boolean(result.cacheHit),
          circuitBroken: Boolean(result.circuitBroken),
          blockedImageNotReturned: Boolean(result.blockedImageNotReturned),
          needsCaregiverConfirm: Boolean(result.needsCaregiverConfirm),
          canUpgradeToTier2: Boolean(result.canUpgradeToTier2),
          label: result.label,
          mimeType: result.mimeType || null,
          mediaType: result.mediaType || null,
          imageBase64: result.imageBase64 || null,
          svg: result.svg || null,
          gate: result.gate || null,
          recipe: result.recipe || null,
          planner: result.planner || null,
          license: result.license || null,
          attribution: result.attribution || null,
          hitCount: result.hitCount || null,
          metrics: result.metrics || null
        });
      },
      { requireJson: true }
    )
  );

  router.post(
    '/confirm',
    withProtection(
      async (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const label = sanitizeCompositionLabel(typeof body.label === 'string' ? body.label : '');
        const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64.replace(/\s+/g, '') : '';
        const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim().toLowerCase() : 'image/png';

        if (!label || !imageBase64 || imageBase64.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) {
          throw createRouterError('INVALID_INPUT', 'label and bounded valid imageBase64 are required', 400);
        }
        if (!ALLOWED_CONFIRM_MIME_TYPES.has(mimeType)) {
          throw createRouterError('INVALID_MIME_TYPE', 'Unsupported mimeType for confirmation', 400);
        }

        const saved = await pipeline.confirmAndCache({
          scopeId: req.pictogramScopeId,
          label,
          mimeType,
          imageBuffer: Buffer.from(imageBase64, 'base64'),
          svg: typeof body.svg === 'string' ? body.svg : null,
          tier: typeof body.tier === 'string' && body.tier.trim() ? body.tier.trim() : 'confirmed_custom',
          recipe: body.recipe || null,
          iconicity: body.iconicity || null,
          license: typeof body.license === 'string' ? body.license : null,
          attribution: typeof body.attribution === 'string' ? body.attribution : null
        });

        return res.status(200).json(saved);
      },
      { requireJson: true }
    )
  );

  router.get(
    '/confirmed',
    withProtection(async (req, res) => {
      if (!cache) {
        throw createRouterError('CACHE_NOT_CONFIGURED', 'Confirmed pictogram cache is not configured', 503);
      }
      const items = cache.listScope(req.pictogramScopeId);
      return res.status(200).json({
        scopeId: req.pictogramScopeId,
        items
      });
    })
  );

  router.delete(
    '/confirmed/:label',
    withProtection(async (req, res) => {
      if (!cache) {
        throw createRouterError('CACHE_NOT_CONFIGURED', 'Confirmed pictogram cache is not configured', 503);
      }
      const label = sanitizeCompositionLabel(req.params && req.params.label ? req.params.label : '');
      if (!label) {
        throw createRouterError('INVALID_LABEL', 'Valid label parameter is required', 400);
      }
      const deleted = cache.deleteConfirmed(req.pictogramScopeId, label);
      if (!deleted) {
        throw createRouterError('CONFIRMED_NOT_FOUND', 'Confirmed pictogram not found in scope', 404);
      }
      return res.status(200).json({ deleted: true, label });
    })
  );

  router.use((error, req, res, next) => {
    if (!error) return next();
    if (error.type === 'entity.too.large') {
      return res.status(413).json({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request body exceeds allowed size'
        }
      });
    }
    return res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'Invalid JSON request body'
      }
    });
  });

  return router;
}

module.exports = {
  createPictogramCompositionRouter,
  deriveUserScopeId
};

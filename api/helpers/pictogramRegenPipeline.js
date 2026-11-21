'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const Database = require('better-sqlite3');

const {
  MAX_PICTOGRAM_IMAGE_BYTES,
  isGif89aBuffer,
  isPngBuffer,
  normalizeAnimatedPictogramImage,
  normalizePublicPictogramImage
} = require('./pictogramImage');
const {
  composeMissingPictogram,
  escapeXml,
  planSymbolComposition,
  sanitizeCompositionLabel
} = require('./pictogramComposer');
const { shouldInvokeRecipePlanner } = require('./pictogramRecipePlanner');
const {
  buildForbiddenConfusionsForLabel,
  verifyIconicityByBlindBackTranslation
} = require('./pictogramIconicityGate');
const {
  buildReferenceEditPrompt
} = require('./communicationPictogramGenerationProvider');

const CANVAS_SIZE = 300;
const SPRITE_FRAME_DELAYS_MS = Object.freeze([700, 950]);

function createPipelineError(message, status = 500, code = 'PICTOGRAM_PIPELINE_ERROR') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function assertNoPersonalIdentityLeak(input = {}) {
  if (
    input.containsPersonalPhoto ||
    input.hasRealPersonAvatar ||
    input.devicePrivatePhoto
  ) {
    throw createPipelineError(
      'Personal photos cannot be uploaded for cloud image editing',
      403,
      'PRIVACY_PERSONAL_PHOTO_BLOCKED'
    );
  }
}

function anonymizePersonReferenceLabel(label, registeredPersonNames = []) {
  const cleanLabel = sanitizeCompositionLabel(label);
  const uniqueNames = Array.from(
    new Set(
      (Array.isArray(registeredPersonNames) ? registeredPersonNames : [])
        .map(n => String(n || '').trim())
        .filter(Boolean)
    )
  ).sort((a, b) => b.length - a.length);

  let sanitizedLabel = cleanLabel;
  const replacements = [];
  let aliasIdx = 1;

  for (const name of uniqueNames) {
    if (sanitizedLabel.includes(name)) {
      const alias = `PERSON_${aliasIdx}`;
      aliasIdx += 1;
      sanitizedLabel = sanitizedLabel.split(name).join(alias);
      replacements.push({ name, alias });
    }
  }

  return { sanitizedLabel, replacements };
}

function buildRefinedOverlaySvg(label, badgeText = '基准重绘') {
  const safeLabel = escapeXml(sanitizeCompositionLabel(label));
  const safeBadge = escapeXml(badgeText);
  const len = sanitizeCompositionLabel(label).length;
  const fontSize = len <= 5 ? 26 : len <= 7 ? 21 : 17;
  const textY = len <= 5 ? 276 : len <= 7 ? 275 : 274;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300">
  <rect x="2" y="2" width="296" height="296" rx="20" fill="none" stroke="#CBD5E1" stroke-width="4"/>
  <rect x="212" y="10" width="78" height="24" rx="8" fill="#DCFCE7"/>
  <text x="251" y="27" text-anchor="middle" font-size="13" font-weight="700" font-family="Microsoft YaHei, SimHei, sans-serif" fill="#15803D">${safeBadge}</text>
  <rect x="8" y="242" width="284" height="50" rx="12" fill="#F1F5F9"/>
  <text x="150" y="${textY}" text-anchor="middle" font-size="${fontSize}" font-weight="700" font-family="Microsoft YaHei, SimHei, sans-serif" fill="#0F172A">${safeLabel}</text>
</svg>`;
}

async function trimAndFitPanel(panelPngBuffer, { boxW, boxH, targetW = CANVAS_SIZE, targetH = CANVAS_SIZE, leftPad = null, topPad = null } = {}) {
  let trimmedBuf = panelPngBuffer;
  try {
    trimmedBuf = await sharp(panelPngBuffer)
      .flatten({ background: '#ffffff' })
      .trim({ threshold: 10 })
      .png()
      .toBuffer();
  } catch (_) {
    // Solid or near-edge image falls back to untrimmed panel
    trimmedBuf = await sharp(panelPngBuffer)
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer();
  }

  const fitted = await sharp(trimmedBuf)
    .resize(boxW, boxH, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png()
    .toBuffer();

  const offsetLeft = leftPad !== null ? leftPad : Math.floor((targetW - boxW) / 2);
  const offsetTop = topPad !== null ? topPad : Math.floor((targetH - boxH) / 2);

  return sharp({
    create: {
      width: targetW,
      height: targetH,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  })
    .composite([{ input: fitted, left: offsetLeft, top: offsetTop }])
    .png()
    .toBuffer();
}

async function composeCardFromCleanPanel(panelPngBuffer, label, badgeText = '基准重绘') {
  const placed = await trimAndFitPanel(panelPngBuffer, {
    boxW: 268,
    boxH: 196,
    leftPad: 16,
    topPad: 38
  });
  const overlaySvg = Buffer.from(buildRefinedOverlaySvg(label, badgeText), 'utf8');
  return sharp(placed)
    .composite([{ input: overlaySvg, left: 0, top: 0 }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function sliceTwoPanelSpriteToGif(spriteBuffer, options = {}) {
  if (!Buffer.isBuffer(spriteBuffer) || !spriteBuffer.length || spriteBuffer.length > 8 * 1024 * 1024) {
    throw createPipelineError('Invalid sprite buffer', 400, 'INVALID_SPRITE_BUFFER');
  }

  let meta;
  try {
    meta = await sharp(spriteBuffer, { failOn: 'warning' }).metadata();
  } catch (_) {
    throw createPipelineError('Unable to decode sprite image', 400, 'INVALID_SPRITE_BUFFER');
  }

  const width = Number(meta && meta.width ? meta.width : 0);
  const height = Number(meta && meta.height ? meta.height : 0);
  if (width < 64 || height < 32 || width < height * 1.2) {
    throw createPipelineError(
      `Expected wide 2-panel horizontal sprite (width >= 1.2 * height), got ${width}x${height}`,
      400,
      'INVALID_SPRITE_DIMENSIONS'
    );
  }

  const halfW = Math.floor(width / 2);
  const gutter = Math.min(8, Math.floor(width * 0.01));
  const leftWidth = Math.max(1, halfW - Math.floor(gutter / 2));
  const rightStart = halfW + Math.ceil(gutter / 2);
  const rightWidth = Math.max(1, width - rightStart);

  const leftRaw = await sharp(spriteBuffer)
    .extract({ left: 0, top: 0, width: leftWidth, height })
    .png()
    .toBuffer();
  const rightRaw = await sharp(spriteBuffer)
    .extract({ left: rightStart, top: 0, width: rightWidth, height })
    .png()
    .toBuffer();

  const noLabelPngBuffer = await trimAndFitPanel(rightRaw, {
    boxW: 264,
    boxH: 264,
    leftPad: 18,
    topPad: 18
  });

  const includeLabel = options.includeLabel !== false;
  const label = sanitizeCompositionLabel(options.label || '动作图标');
  const badgeText = options.badgeText || '基准重绘';

  const frame0Png = includeLabel
    ? await composeCardFromCleanPanel(leftRaw, label, badgeText)
    : await trimAndFitPanel(leftRaw, { boxW: 264, boxH: 264, leftPad: 18, topPad: 18 });
  const frame1Png = includeLabel
    ? await composeCardFromCleanPanel(rightRaw, label, badgeText)
    : noLabelPngBuffer;

  const raw0 = await sharp(frame0Png).ensureAlpha().raw().toBuffer();
  const raw1 = await sharp(frame1Png).ensureAlpha().raw().toBuffer();
  const strip = Buffer.concat([raw0, raw1]);

  const encodedGif = await sharp(strip, {
    raw: {
      width: CANVAS_SIZE,
      height: CANVAS_SIZE * 2,
      channels: 4,
      pageHeight: CANVAS_SIZE
    }
  })
    .gif({
      colours: 32,
      dither: 0,
      effort: 5,
      delay: Array.from(SPRITE_FRAME_DELAYS_MS),
      loop: 2
    })
    .toBuffer();

  const gated = await normalizeAnimatedPictogramImage(encodedGif);
  return {
    gifBuffer: gated.buffer,
    gifInfo: {
      contentType: gated.contentType,
      pages: gated.pages,
      width: gated.width,
      height: gated.height,
      bytes: gated.buffer.length
    },
    noLabelPngBuffer,
    cardPngBuffer: frame1Png
  };
}

async function finalizeRefinedStaticCard(rawBuffer, label, options = {}) {
  if (!Buffer.isBuffer(rawBuffer) || !rawBuffer.length || rawBuffer.length > 8 * 1024 * 1024) {
    throw createPipelineError('Invalid refined image buffer', 400, 'INVALID_REFINED_IMAGE');
  }

  const noLabelPngBuffer = await trimAndFitPanel(rawBuffer, {
    boxW: 264,
    boxH: 264,
    leftPad: 18,
    topPad: 18
  });

  const cleanLabel = sanitizeCompositionLabel(label || '图卡');
  const includeLabel = options.includeLabel !== false;
  const cardPngBuffer = includeLabel
    ? await composeCardFromCleanPanel(rawBuffer, cleanLabel, options.badgeText || '基准重绘')
    : noLabelPngBuffer;

  let svg = null;
  if (typeof options.vectorizer === 'function') {
    svg = await options.vectorizer(noLabelPngBuffer);
    if (typeof svg !== 'string' || !/<svg\b/i.test(svg) || /<script\b/i.test(svg)) {
      throw createPipelineError('Vectorizer returned invalid or unsafe SVG', 502, 'INVALID_VECTORIZED_SVG');
    }
  }

  return {
    noLabelPngBuffer,
    cardPngBuffer,
    svg
  };
}

function createConfirmedPictogramCache({ dbPath = ':memory:' } = {}) {
  if (dbPath && dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  if (dbPath && dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS confirmed_pictograms (
      scope_id TEXT NOT NULL,
      normalized_label TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      media_type TEXT NOT NULL,
      image_blob BLOB NOT NULL,
      svg_text TEXT,
      tier TEXT NOT NULL,
      recipe_json TEXT,
      iconicity_json TEXT,
      license TEXT,
      attribution TEXT,
      confirmed_at TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (scope_id, normalized_label)
    );
  `);

  const selectStmt = db.prepare(
    'SELECT * FROM confirmed_pictograms WHERE scope_id = ? AND normalized_label = ?'
  );
  const hitStmt = db.prepare(
    'UPDATE confirmed_pictograms SET hit_count = hit_count + 1 WHERE scope_id = ? AND normalized_label = ?'
  );
  const upsertStmt = db.prepare(`
    INSERT OR REPLACE INTO confirmed_pictograms (
      scope_id, normalized_label, mime_type, media_type, image_blob, svg_text,
      tier, recipe_json, iconicity_json, license, attribution, confirmed_at, hit_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);
  const deleteStmt = db.prepare(
    'DELETE FROM confirmed_pictograms WHERE scope_id = ? AND normalized_label = ?'
  );
  const listStmt = db.prepare(
    'SELECT scope_id, normalized_label, mime_type, media_type, tier, confirmed_at, hit_count FROM confirmed_pictograms WHERE scope_id = ? ORDER BY confirmed_at DESC'
  );

  function parseScopeAndLabel(scopeId, rawLabel) {
    const scope = String(scopeId || '').trim();
    const label = sanitizeCompositionLabel(rawLabel);
    if (!scope) throw createPipelineError('scopeId is required', 400, 'INVALID_SCOPE_ID');
    if (!label) throw createPipelineError('label is required', 400, 'INVALID_LABEL');
    return { scope, label };
  }

  return {
    getConfirmed(scopeId, rawLabel) {
      const { scope, label } = parseScopeAndLabel(scopeId, rawLabel);
      const row = selectStmt.get(scope, label);
      if (!row) return null;
      hitStmt.run(scope, label);
      const nextHits = Number(row.hit_count || 0) + 1;
      const imageBuffer = Buffer.from(row.image_blob);
      return {
        scopeId: row.scope_id,
        label: row.normalized_label,
        mimeType: row.mime_type,
        mediaType: row.media_type,
        imageBuffer,
        imageBase64: imageBuffer.toString('base64'),
        svg: row.svg_text || null,
        tier: row.tier,
        recipe: row.recipe_json ? JSON.parse(row.recipe_json) : null,
        iconicity: row.iconicity_json ? JSON.parse(row.iconicity_json) : null,
        license: row.license || null,
        attribution: row.attribution || null,
        confirmedAt: row.confirmed_at,
        hitCount: nextHits,
        cacheHit: true
      };
    },

    async saveConfirmed(scopeId, record = {}) {
      const { scope, label } = parseScopeAndLabel(scopeId, record.label);
      const rawBuf = Buffer.isBuffer(record.imageBuffer)
        ? record.imageBuffer
        : typeof record.imageBase64 === 'string' && record.imageBase64
        ? Buffer.from(record.imageBase64, 'base64')
        : null;

      if (!rawBuf || !rawBuf.length) {
        throw createPipelineError('imageBuffer is required to cache confirmed pictogram', 400, 'INVALID_IMAGE');
      }

      const wantGif = record.mimeType === 'image/gif';
      if (wantGif && !isGif89aBuffer(rawBuf)) {
        throw createPipelineError('Expected valid GIF89a bytes for image/gif cache entry', 400, 'INVALID_IMAGE');
      }

      const normalized = await normalizePublicPictogramImage(rawBuf, {
        allowAnimatedGif: wantGif
      });
      const confirmedAt = new Date().toISOString();
      const mediaType = normalized.contentType === 'image/gif' ? 'gif' : 'image';

      upsertStmt.run(
        scope,
        label,
        normalized.contentType,
        mediaType,
        normalized.buffer,
        record.svg || null,
        record.tier || 'confirmed_custom',
        record.recipe ? JSON.stringify(record.recipe) : null,
        record.iconicity ? JSON.stringify(record.iconicity) : null,
        record.license || null,
        record.attribution || null,
        confirmedAt
      );

      return {
        saved: true,
        scopeId: scope,
        label,
        mimeType: normalized.contentType,
        mediaType,
        bytes: normalized.buffer.length,
        tier: record.tier || 'confirmed_custom',
        confirmedAt
      };
    },

    deleteConfirmed(scopeId, rawLabel) {
      const { scope, label } = parseScopeAndLabel(scopeId, rawLabel);
      const info = deleteStmt.run(scope, label);
      return info.changes > 0;
    },

    listScope(scopeId) {
      const scope = String(scopeId || '').trim();
      if (!scope) throw createPipelineError('scopeId is required', 400, 'INVALID_SCOPE_ID');
      return listStmt.all(scope);
    },

    close() {
      db.close();
    }
  };
}

function createTwoTierPictogramPipeline({
  imageEditClient = null,
  vlmClient = null,
  vlmModel = '',
  cache = null,
  vectorizer = null,
  recipePlanner = null
} = {}) {
  return {
    async resolveMissingPictogram(input = {}, context = {}) {
      const t0 = Date.now();
      const label = sanitizeCompositionLabel(input.label);
      if (!label) {
        throw createPipelineError('label is required', 400, 'INVALID_LABEL');
      }

      const scopeId = String(input.scopeId || '').trim();
      const includeLabel = input.includeLabel !== false;

      // Stage 0: Confirmed tenant/family SQLite cache hit (0 tokens, <2ms)
      if (cache && scopeId && !input.bypassCache) {
        const hit = cache.getConfirmed(scopeId, label);
        if (hit) {
          return {
            status: 'cache_hit',
            tier: 'cached_confirmed',
            cacheHit: true,
            circuitBroken: false,
            label: hit.label,
            mimeType: hit.mimeType,
            mediaType: hit.mediaType,
            imageBuffer: hit.imageBuffer,
            imageBase64: hit.imageBase64,
            svg: hit.svg,
            recipe: hit.recipe,
            gate: hit.iconicity,
            license: hit.license,
            attribution: hit.attribution,
            hitCount: hit.hitCount,
            metrics: { totalMs: Date.now() - t0 }
          };
        }
      }

      const anonymization = anonymizePersonReferenceLabel(label, input.registeredPersonNames);
      const detRecipe = planSymbolComposition(label);
      let plannedRecipe = detRecipe;
      let plannerMeta = {
        usedLlm: false,
        skippedReason: recipePlanner ? 'deterministic_sufficient' : 'planner_not_configured',
        fallbackReason: null,
        candidateCount: 0,
        latencyMs: 0,
        usage: null
      };

      if (
        recipePlanner &&
        typeof recipePlanner.planOpenVocabRecipe === 'function' &&
        (Boolean(input.forceRecipePlanner) || shouldInvokeRecipePlanner(detRecipe))
      ) {
        const plannerRes = await recipePlanner.planOpenVocabRecipe({
          label,
          sanitizedLabel: anonymization.sanitizedLabel,
          deterministicRecipe: detRecipe,
          force: Boolean(input.forceRecipePlanner)
        });
        if (plannerRes && plannerRes.recipe) {
          plannedRecipe = plannerRes.recipe;
        }
        plannerMeta = {
          usedLlm: Boolean(plannerRes && plannerRes.usedLlm),
          skippedReason: (plannerRes && plannerRes.skippedReason) || null,
          fallbackReason: (plannerRes && plannerRes.fallbackReason) || null,
          negationEnforced: Boolean(plannerRes && plannerRes.negationEnforced),
          candidateCount: Number((plannerRes && plannerRes.candidateCount) || 0),
          latencyMs: Number((plannerRes && plannerRes.latencyMs) || 0),
          usage: (plannerRes && plannerRes.usage) || null
        };
      }

      // Stage 1: Tier-1 Mulberry composition + micro-GIF
      const tier1 = await composeMissingPictogram(label, {
        recipe: plannedRecipe,
        format: 'all',
        includeLabel,
        includeNoLabelPng: true
      });

      const shouldRunTier2 =
        Boolean(imageEditClient) &&
        (Boolean(input.forceRefinement) || Boolean(tier1.recipe.needsRegenFallback));

      if (!shouldRunTier2) {
        return {
          status: 'ready',
          tier: 'tier1_composed',
          cacheHit: false,
          circuitBroken: false,
          needsRegenFallback: Boolean(tier1.recipe.needsRegenFallback),
          canUpgradeToTier2: Boolean(imageEditClient),
          label,
          mimeType: 'image/gif',
          mediaType: 'gif',
          imageBuffer: tier1.gifBuffer,
          imageBase64: tier1.gifBuffer.toString('base64'),
          pngBuffer: tier1.pngBuffer,
          noLabelPngBuffer: tier1.noLabelPngBuffer,
          svg: tier1.svg,
          recipe: tier1.recipe,
          planner: plannerMeta,
          license: tier1.recipe.license,
          attribution: tier1.recipe.attribution,
          sourceParts: tier1.recipe.sourceParts,
          metrics: { ...tier1.metrics, totalMs: Date.now() - t0 }
        };
      }

      // Stage 2: Privacy check + anonymization + Reference-based regeneration
      assertNoPersonalIdentityLeak(input);
      const isAnimatedAction =
        typeof input.isAnimatedAction === 'boolean'
          ? input.isAnimatedAction
          : ['act_with', 'container_put'].includes(tier1.recipe.op);

      const regenHint = input.regenHint || tier1.recipe.regenHint || '';
      const prompt = buildReferenceEditPrompt({
        label: anonymization.sanitizedLabel,
        regenHint,
        isAnimatedAction
      });

      let referencePngBuffer = tier1.noLabelPngBuffer;
      if (!isPngBuffer(referencePngBuffer) && tier1.recipe.referencePartId) {
        const refSvg = loadCleanMulberrySvg(tier1.recipe.referencePartId);
        if (refSvg) {
          referencePngBuffer = await sharp(Buffer.from(refSvg, 'utf8'))
            .resize(300, 300, { fit: 'contain', background: '#ffffff' })
            .flatten({ background: '#ffffff' })
            .png()
            .toBuffer();
        }
      }

      if (!imageEditClient || typeof imageEditClient.editFromReference !== 'function') {
        throw createPipelineError('imageEditClient.editFromReference is required for Stage 2', 503, 'IMAGE_EDIT_NOT_CONFIGURED');
      }

      const editRes = await imageEditClient.editFromReference(
        {
          label: anonymization.sanitizedLabel,
          referencePngBuffer,
          prompt,
          isAnimatedAction,
          regenHint
        },
        context
      );

      const rawOutputBuf = (editRes && (editRes.rawImageBuffer || editRes.buffer)) || null;
      const tier2 = isAnimatedAction
        ? await sliceTwoPanelSpriteToGif(rawOutputBuf, { label, includeLabel })
        : await finalizeRefinedStaticCard(rawOutputBuf, label, { includeLabel, vectorizer });

      // Stage 3: Blind Iconicity Back-Translation Safety Gate (strictly no-label image)
      let gate = {
        passed: true,
        tier: 'unchecked_no_vlm',
        top1Hit: false,
        needsLabel: false,
        reason: 'vlm_not_configured',
        guesses: []
      };

      if (vlmClient) {
        const forbidden = buildForbiddenConfusionsForLabel(label, input.forbiddenConfusions);
        gate = await verifyIconicityByBlindBackTranslation({
          labelFreePngBuffer: tier2.noLabelPngBuffer,
          targetLabel: label,
          allowedSynonyms: input.allowedSynonyms,
          forbiddenConfusions: forbidden,
          vlmClient,
          model: input.vlmModel || vlmModel
        });

        if (!gate.passed) {
          return {
            status: 'circuit_broken',
            tier: 'fallback_text_only',
            cacheHit: false,
            circuitBroken: true,
            blockedImageNotReturned: true,
            label,
            gate,
            anonymization,
            fallbackTier1: tier1.recipe.needsRegenFallback
              ? null
              : {
                  mimeType: 'image/gif',
                  svg: tier1.svg,
                  gifBytes: tier1.metrics.gifBytes
                },
            planner: plannerMeta,
            usage: (editRes && editRes.usage) || null,
            metrics: { totalMs: Date.now() - t0 }
          };
        }
      }

      const imageBuffer = isAnimatedAction ? tier2.gifBuffer : tier2.cardPngBuffer;
      const mimeType = isAnimatedAction ? 'image/gif' : 'image/png';
      const mediaType = isAnimatedAction ? 'gif' : 'image';

      return {
        status: 'ready_for_caregiver_confirm',
        tier: 'tier2_regenerated',
        cacheHit: false,
        circuitBroken: false,
        needsCaregiverConfirm: true,
        isAnimatedAction,
        label,
        mimeType,
        mediaType,
        imageBuffer,
        imageBase64: imageBuffer.toString('base64'),
        cardPngBuffer: tier2.cardPngBuffer,
        noLabelPngBuffer: tier2.noLabelPngBuffer,
        svg: tier2.svg || null,
        recipe: tier1.recipe,
        planner: plannerMeta,
        gate,
        anonymization,
        license: 'Device-Private Generated (Ref: Mulberry CC BY-SA 2.0)',
        attribution: tier1.recipe.attribution,
        usage: (editRes && editRes.usage) || null,
        metrics: {
          totalMs: Date.now() - t0,
          imageBytes: imageBuffer.length
        }
      };
    },

    async confirmAndCache(entry = {}) {
      if (!cache) {
        throw createPipelineError('Confirmed pictogram cache is not configured', 503, 'CACHE_NOT_CONFIGURED');
      }
      if (entry.iconicity && entry.iconicity.passed === false) {
        throw createPipelineError(
          'Refusing to cache pictogram that failed iconicity gate',
          422,
          'ICONICITY_GATE_REJECTED'
        );
      }
      return cache.saveConfirmed(entry.scopeId, entry);
    }
  };
}

function createPictogramPipelineController({ pipeline } = {}) {
  if (!pipeline || typeof pipeline.resolveMissingPictogram !== 'function') {
    throw new Error('pipeline with resolveMissingPictogram is required');
  }

  return {
    async resolvePictogram(req, res) {
      const body = req.body || {};
      const label = sanitizeCompositionLabel(typeof body.label === 'string' ? body.label : '');
      if (!label) {
        return res.status(400).json({ error: { message: 'label is required (1-24 chars)' } });
      }

      try {
        const result = await pipeline.resolveMissingPictogram(
          {
            label,
            scopeId: body.scopeId,
            forceRefinement: Boolean(body.forceRefinement),
            bypassCache: Boolean(body.bypassCache),
            isAnimatedAction: typeof body.isAnimatedAction === 'boolean' ? body.isAnimatedAction : undefined,
            includeLabel: body.includeLabel !== false,
            regenHint: body.regenHint,
            allowedSynonyms: body.allowedSynonyms,
            forbiddenConfusions: body.forbiddenConfusions,
            registeredPersonNames: body.registeredPersonNames,
            containsPersonalPhoto: Boolean(body.containsPersonalPhoto),
            hasRealPersonAvatar: Boolean(body.hasRealPersonAvatar),
            devicePrivatePhoto: Boolean(body.devicePrivatePhoto)
          },
          { userId: req.user && req.user.id ? req.user.id : body.scopeId }
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
          license: result.license || null,
          attribution: result.attribution || null,
          hitCount: result.hitCount || null,
          metrics: result.metrics || null
        });
      } catch (error) {
        const status = error.status || 500;
        return res.status(status).json({
          error: {
            message: status >= 500 ? 'Pictogram pipeline failed' : error.message,
            code: error.code || undefined
          }
        });
      }
    },

    async confirmPictogram(req, res) {
      const body = req.body || {};
      const scopeId = String(body.scopeId || '').trim();
      const label = sanitizeCompositionLabel(typeof body.label === 'string' ? body.label : '');
      const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64.trim() : '';

      if (!scopeId || !label || !imageBase64 || imageBase64.length > 4 * 1024 * 1024) {
        return res.status(400).json({
          error: { message: 'scopeId, label, and bounded imageBase64 are required' }
        });
      }

      try {
        const saved = await pipeline.confirmAndCache({
          scopeId,
          label,
          mimeType: body.mimeType || 'image/png',
          imageBuffer: Buffer.from(imageBase64, 'base64'),
          svg: typeof body.svg === 'string' ? body.svg : null,
          tier: body.tier || 'confirmed_custom',
          recipe: body.recipe || null,
          iconicity: body.iconicity || null,
          license: body.license || null,
          attribution: body.attribution || null
        });
        return res.status(200).json(saved);
      } catch (error) {
        const status = error.status || 500;
        return res.status(status).json({
          error: {
            message: status >= 500 ? 'Failed to confirm pictogram' : error.message,
            code: error.code || undefined
          }
        });
      }
    }
  };
}

module.exports = {
  CANVAS_SIZE,
  SPRITE_FRAME_DELAYS_MS,
  anonymizePersonReferenceLabel,
  assertNoPersonalIdentityLeak,
  createConfirmedPictogramCache,
  createPictogramPipelineController,
  createTwoTierPictogramPipeline,
  finalizeRefinedStaticCard,
  sliceTwoPanelSpriteToGif
};

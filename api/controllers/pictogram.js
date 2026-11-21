'use strict';

const pictogramSearch = require('../helpers/pictogramSearch');
const pictogramComposer = require('../helpers/pictogramComposer');

module.exports = {
  composePictogram,
  getArasaacImage,
  getGlobalSymbolsImage,
  getOpenSymbolsImage,
  searchGlobalSymbols,
  searchPictograms
};

async function composePictogram(req, res) {
  const body = req.body || {};
  const rawLabel = typeof body.label === 'string' ? body.label.trim() : '';
  const collapsed = rawLabel.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!collapsed || collapsed.length > pictogramComposer.MAX_COMPOSITION_LABEL_LENGTH) {
    return res.status(400).json({
      error: { message: 'label must be a non-empty string up to 24 characters' }
    });
  }

  const format =
    body.format !== undefined ? String(body.format).trim().toLowerCase() : 'gif';
  if (!['svg', 'png', 'gif', 'all'].includes(format)) {
    return res.status(400).json({
      error: { message: 'format must be one of svg, png, gif, all' }
    });
  }

  const includeLabel = body.includeLabel !== false;

  try {
    const result = await pictogramComposer.composeMissingPictogram(collapsed, {
      format,
      includeLabel
    });

    let mimeType = 'image/gif';
    let imageBuffer = result.gifBuffer;
    let mediaType = 'gif';
    if (format === 'svg') {
      mimeType = 'image/svg+xml';
      imageBuffer = Buffer.from(result.svg, 'utf8');
      mediaType = 'image';
    } else if (format === 'png') {
      mimeType = 'image/png';
      imageBuffer = result.pngBuffer;
      mediaType = 'image';
    }

    return res.status(200).json({
      label: result.recipe.label,
      mode: result.recipe.mode,
      op: result.recipe.op,
      ruleId: result.recipe.ruleId,
      needsRegenFallback: Boolean(result.recipe.needsRegenFallback),
      referencePartId: result.recipe.referencePartId || null,
      regenHint: result.recipe.regenHint || '',
      mediaType,
      mimeType,
      imageBase64: imageBuffer ? imageBuffer.toString('base64') : '',
      svg: result.svg,
      license: result.recipe.license,
      attribution: result.recipe.attribution,
      sourceParts: result.recipe.sourceParts,
      metrics: result.metrics
    });
  } catch (error) {
    return res.status(500).json({
      error: { message: 'Failed to compose pictogram' }
    });
  }
}

async function searchPictograms(req, res) {
  const tokens = req.body && req.body.tokens;
  if (!Array.isArray(tokens)) {
    return res.status(400).json({ error: { message: 'tokens is required' } });
  }

  const results = await pictogramSearch.searchRuntimePictograms(tokens);
  return res.status(200).json({ results });
}

async function searchGlobalSymbols(req, res) {
  const body = req.body || {};
  const results = await pictogramSearch.searchGlobalSymbolsLabels({
    query: body.query,
    language: body.language,
    limit: body.limit
  });
  return res.status(200).json({ results });
}

async function getArasaacImage(req, res) {
  const id =
    req.swagger && req.swagger.params && req.swagger.params.id
      ? req.swagger.params.id.value
      : req.params.id;

  try {
    const image = await pictogramSearch.loadArasaacImage(id);
    res.set('Content-Type', image.contentType);
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    return res.status(200).send(image.buffer);
  } catch (error) {
    const status = error.status || 502;
    return res.status(status).json({ error: { message: error.message } });
  }
}

async function getOpenSymbolsImage(req, res) {
  const token =
    req.swagger && req.swagger.params && req.swagger.params.token
      ? req.swagger.params.token.value
      : req.params.token;

  try {
    const image = await pictogramSearch.loadOpenSymbolsImage(token);
    res.set('Content-Type', image.contentType);
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    return res.status(200).send(image.buffer);
  } catch (error) {
    const status = error.status || 502;
    return res.status(status).json({ error: { message: error.message } });
  }
}

async function getGlobalSymbolsImage(req, res) {
  const token =
    req.swagger && req.swagger.params && req.swagger.params.token
      ? req.swagger.params.token.value
      : req.params.token;

  try {
    const image = await pictogramSearch.loadGlobalSymbolsImage(token);
    res.set('Content-Type', image.contentType);
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    return res.status(200).send(image.buffer);
  } catch (error) {
    const status = error.status || 502;
    return res.status(status).json({ error: { message: error.message } });
  }
}

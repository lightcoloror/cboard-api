'use strict';

const pictogramSearch = require('../helpers/pictogramSearch');

module.exports = {
  getArasaacImage,
  getGlobalSymbolsImage,
  getOpenSymbolsImage,
  searchGlobalSymbols,
  searchPictograms
};

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

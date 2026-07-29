'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { URL } = require('url');

const {
  normalizePublicPictogramAttribution
} = require('./pictogramAttribution');
const { normalizePublicPictogramImage } = require('./pictogramImage');

const DEFAULT_API_V2 = 'https://globalsymbols.com/api/v2';
const DEFAULT_API_V1 = 'https://globalsymbols.com/api/v1';
const GLOBAL_SYMBOLS_HOST = 'globalsymbols.com';
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_QUERY_LENGTH = 80;
const MAX_RESULTS = 20;
const SIGNATURE_LENGTH = 32;
const MAX_IMAGE_TOKEN_LENGTH = 4096;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 15 * 1000;
const DEFAULT_MAX_CACHE_ENTRIES = 256;

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeBaseUrl(value, fallback) {
  return String(value || fallback)
    .trim()
    .replace(/\/+$/, '');
}

function normalizeQuery(value) {
  const query = String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return query && query.length <= MAX_QUERY_LENGTH ? query : null;
}

function normalizeLanguage(value) {
  const language = String(value || '')
    .trim()
    .toLowerCase();
  if (language === 'zh' || language === 'zh-cn' || language === 'zho') {
    return 'zho';
  }
  if (language === 'en' || language === 'en-us' || language === 'eng') {
    return 'eng';
  }
  return /^[a-z]{3}$/.test(language) ? language : 'eng';
}

function normalizeImageUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    const hostname = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      (hostname !== GLOBAL_SYMBOLS_HOST &&
        !hostname.endsWith(`.${GLOBAL_SYMBOLS_HOST}`))
    ) {
      return null;
    }
    return parsed.toString();
  } catch (error) {
    return null;
  }
}

function encodeBase64Url(value) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (base64.length % 4)) % 4;
  return Buffer.from(base64 + '='.repeat(padding), 'base64').toString('utf8');
}

function createImageToken(imageUrl, secret) {
  const normalizedUrl = normalizeImageUrl(imageUrl);
  if (!normalizedUrl || !secret) return null;
  const payload = encodeBase64Url(normalizedUrl);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`global-symbols:${payload}`)
    .digest('hex')
    .slice(0, SIGNATURE_LENGTH);
  return `${payload}.${signature}`;
}

function readImageToken(value, secret) {
  const token = String(value || '').trim();
  const match = token.match(/^([A-Za-z0-9_-]+)\.([a-f0-9]{32})$/);
  if (!secret || !match || token.length > MAX_IMAGE_TOKEN_LENGTH) return null;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`global-symbols:${match[1]}`)
    .digest('hex')
    .slice(0, SIGNATURE_LENGTH);
  const actualBuffer = Buffer.from(match[2], 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    return normalizeImageUrl(decodeBase64Url(match[1]));
  } catch (error) {
    return null;
  }
}

function normalizeLicense(license) {
  if (!license || typeof license !== 'object') return null;
  const name = String(license.name || '').trim();
  const version = String(license.version || '').trim();
  return name ? [name, version].filter(Boolean).join(' ') : null;
}

function buildAttribution(item) {
  const picto = item && item.picto;
  const symbolset = picto && picto.symbolset;
  const license = symbolset && normalizeLicense(symbolset.licence);
  const symbolsetName = String(
    (symbolset && (symbolset.name || symbolset.slug)) || ''
  ).trim();
  if (!picto || !symbolset || !symbolsetName || !license) return null;
  return normalizePublicPictogramAttribution({
    provider: 'globalsymbols',
    originalId: String(picto.id || ''),
    name: `Global Symbols / ${symbolsetName}`,
    license,
    licenseUrl: symbolset.licence && symbolset.licence.url,
    author: symbolset.publisher,
    authorUrl: symbolset.publisher_url,
    sourceUrl: picto.image_url,
    repoKey: symbolset.slug
  });
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createGlobalSymbolsProvider(options = {}) {
  const http = options.http || axios;
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, 8000);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const apiKey = String(
    Object.prototype.hasOwnProperty.call(options, 'apiKey') &&
      options.apiKey !== undefined
      ? options.apiKey || ''
      : process.env.GLOBALSYMBOLS_API_KEY || ''
  ).trim();
  const proxySecret = String(
    Object.prototype.hasOwnProperty.call(options, 'proxySecret') &&
      options.proxySecret !== undefined
      ? options.proxySecret || ''
      : process.env.PICTOGRAM_IMAGE_PROXY_SECRET || process.env.JWT_SECRET || ''
  ).trim();
  const apiV2 = normalizeBaseUrl(options.apiV2, DEFAULT_API_V2);
  const apiV1 = normalizeBaseUrl(options.apiV1, DEFAULT_API_V1);
  const cacheTtlMs = normalizePositiveInteger(
    options.cacheTtlMs,
    DEFAULT_CACHE_TTL_MS
  );
  const negativeCacheTtlMs = normalizePositiveInteger(
    options.negativeCacheTtlMs,
    DEFAULT_NEGATIVE_CACHE_TTL_MS
  );
  const maxCacheEntries = normalizePositiveInteger(
    options.maxCacheEntries,
    DEFAULT_MAX_CACHE_ENTRIES
  );
  const cache = new Map();
  const inFlight = new Map();

  function cacheKey(query, language, limit, mode) {
    return JSON.stringify([query, language, limit, mode]);
  }

  function readCache(key) {
    const cached = cache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= now()) {
      cache.delete(key);
      return null;
    }
    cache.delete(key);
    cache.set(key, cached);
    return cached.value;
  }

  function writeCache(key, value) {
    cache.delete(key);
    cache.set(key, {
      value,
      expiresAt: now() + (value.length ? cacheTtlMs : negativeCacheTtlMs)
    });
    while (cache.size > maxCacheEntries) {
      cache.delete(cache.keys().next().value);
    }
  }

  async function requestLabels(query, language, limit, requireV2) {
    if (!proxySecret || (requireV2 && !apiKey)) return [];
    const useV2 = Boolean(apiKey);
    const mode = useV2 ? 'v2' : 'legacy-v1';
    const key = cacheKey(query, language, limit, mode);
    const cached = readCache(key);
    if (cached) return cached;
    if (inFlight.has(key)) return inFlight.get(key);

    const pending = Promise.resolve()
      .then(() =>
        http.get(`${useV2 ? apiV2 : apiV1}/labels/search`, {
          timeout: timeoutMs,
          params: {
            query,
            language,
            language_iso_format: '639-3',
            limit,
            ...(useV2 ? { include_preview: true } : {})
          },
          headers: {
            Accept: 'application/json',
            ...(useV2 ? { 'X-Api-Key': apiKey } : {})
          }
        })
      )
      .then(response =>
        Array.isArray(response && response.data) ? response.data : []
      )
      .catch(() => [])
      .then(value => {
        writeCache(key, value);
        return value;
      })
      .finally(() => {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      });
    inFlight.set(key, pending);
    return pending;
  }

  function normalizeLabel(item) {
    if (!item || typeof item !== 'object' || !item.picto) return null;
    const imageToken = createImageToken(item.picto.image_url, proxySecret);
    const text = String(item.text || '').trim();
    const pictogramId = String(item.picto.id || '').trim();
    if (!imageToken || !text || !pictogramId) return null;
    const attribution = buildAttribution(item);
    return {
      id: item.id,
      text,
      text_diacritised: item.text_diacritised || null,
      description: item.description || null,
      language: String(item.language || '').trim(),
      picto: {
        id: item.picto.id,
        symbolset_id: item.picto.symbolset_id,
        part_of_speech: item.picto.part_of_speech || '',
        image_url: `/pictograms/globalsymbols/${imageToken}/image`,
        native_format: 'png',
        adaptable: Boolean(item.picto.adaptable)
      },
      ...(attribution ? { pictogramAttribution: attribution } : {})
    };
  }

  async function searchLabels({ query, language, limit = MAX_RESULTS } = {}) {
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) return [];
    const normalizedLanguage = normalizeLanguage(language);
    const normalizedLimit = Math.min(
      MAX_RESULTS,
      normalizePositiveInteger(limit, MAX_RESULTS)
    );
    const labels = await requestLabels(
      normalizedQuery,
      normalizedLanguage,
      normalizedLimit,
      false
    );
    return labels
      .map(normalizeLabel)
      .filter(Boolean)
      .slice(0, normalizedLimit);
  }

  async function searchRuntimePictograms({ token, query, locale, limit = 4 }) {
    if (!apiKey || !proxySecret) return [];
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) return [];
    const labels = await requestLabels(
      normalizedQuery,
      normalizeLanguage(locale),
      Math.min(4, normalizePositiveInteger(limit, 4)),
      true
    );
    return labels
      .map(normalizeLabel)
      .filter(item => item && item.pictogramAttribution)
      .map(item => ({
        originalId: String(item.picto.id),
        imageUrl: item.picto.image_url,
        label: item.text,
        source: item.pictogramAttribution,
        token: String(token || '').trim()
      }));
  }

  async function loadImage(token) {
    if (!proxySecret) {
      throw createHttpError(
        503,
        'Global Symbols image proxy is not configured'
      );
    }
    const url = readImageToken(token, proxySecret);
    if (!url) throw createHttpError(400, 'Invalid Global Symbols image token');
    let response;
    try {
      response = await http.get(url, {
        timeout: timeoutMs,
        responseType: 'arraybuffer',
        maxContentLength: MAX_IMAGE_BYTES,
        maxBodyLength: MAX_IMAGE_BYTES,
        headers: { Accept: 'image/*' }
      });
    } catch (error) {
      throw createHttpError(502, 'Unable to load Global Symbols pictogram');
    }
    const contentType = String(
      (response.headers && response.headers['content-type']) || ''
    ).split(';')[0];
    const buffer = Buffer.from(response.data || []);
    if (
      !contentType.startsWith('image/') ||
      !buffer.length ||
      buffer.length > MAX_IMAGE_BYTES
    ) {
      throw createHttpError(502, 'Invalid Global Symbols pictogram response');
    }
    try {
      return await normalizePublicPictogramImage(buffer);
    } catch (error) {
      throw createHttpError(502, 'Invalid Global Symbols pictogram response');
    }
  }

  return {
    configured: Boolean(apiKey && proxySecret),
    compatibilityConfigured: Boolean(proxySecret),
    loadImage,
    searchLabels,
    searchRuntimePictograms
  };
}

module.exports = {
  MAX_IMAGE_TOKEN_LENGTH,
  MAX_QUERY_LENGTH,
  MAX_RESULTS,
  createGlobalSymbolsProvider,
  normalizeLanguage,
  normalizeQuery
};

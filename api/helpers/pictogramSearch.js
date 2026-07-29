'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { URL } = require('url');
const {
  getEnglishFallback,
  getReviewedArasaacIds
} = require('./pictogramLexicon');
const {
  normalizePublicPictogramAttribution
} = require('./pictogramAttribution');
const { normalizePublicPictogramImage } = require('./pictogramImage');
const { createGlobalSymbolsProvider } = require('./globalSymbols');

const ARASAAC_API = 'https://api.arasaac.org/v1';
const ARASAAC_STATIC = 'https://static.arasaac.org/pictograms';
const OPENSYMBOLS_API = 'https://www.opensymbols.org';
const OPENSYMBOLS_ALLOWED_REPOS = new Set(['arasaac', 'mulberry', 'sclera']);
const OPENSYMBOLS_IMAGE_HOST_SUFFIXES = [
  'opensymbols.org',
  'cloudfront.net',
  'amazonaws.com'
];
const OPENSYMBOLS_SIGNATURE_LENGTH = 32;
const MAX_OPENSYMBOLS_TOKEN_LENGTH = 4096;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_QUERY_TOKENS = 12;
const MAX_TOKEN_LENGTH = 24;
const MAX_PICTOGRAM_CANDIDATES_PER_TOKEN = 4;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_SEARCH_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 15 * 1000;
const DEFAULT_MAX_SEARCH_CACHE_ENTRIES = 256;
const SKIP_TOKENS = new Set([
  '，',
  '。',
  '！',
  '？',
  ',',
  '.',
  '!',
  '?',
  '、',
  '的',
  '了',
  '吗',
  '呢',
  '啊',
  '呀'
]);

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeToken(value) {
  if (typeof value !== 'string') return null;

  const token = value
    .trim()
    .replace(/^[\s,，。？！!?、]+|[\s,，。？！!?、]+$/g, '');

  if (!token || token.length > MAX_TOKEN_LENGTH || SKIP_TOKENS.has(token)) {
    return null;
  }

  return token;
}

function normalizeTokens(tokens) {
  const result = [];
  const seen = new Set();

  for (const value of Array.isArray(tokens) ? tokens : []) {
    const token = normalizeToken(value);
    if (!token || seen.has(token)) continue;

    seen.add(token);
    result.push(token);
    if (result.length >= MAX_QUERY_TOKENS) break;
  }

  return result;
}

function normalizeArasaacQuery(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function stableId(provider, originalId, token) {
  const hash = crypto
    .createHash('sha1')
    .update(`${provider}:${originalId}:${token}`)
    .digest('hex')
    .slice(0, 12);
  return `runtime_${provider}_${hash}`;
}

function buildArasaacPictogram(token, query, locale, id) {
  return {
    id: stableId('arasaac', String(id), token),
    imageUrl: `/pictograms/arasaac/${id}/image`,
    labels: {
      zh: [token],
      en: [locale === 'en' ? query : getEnglishFallback(token)].filter(Boolean)
    },
    categoryId: 'daily',
    categoryIds: ['daily'],
    synonyms: [],
    source: {
      provider: 'arasaac',
      originalId: String(id),
      name: 'ARASAAC',
      license: 'CC BY-NC-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
      author: 'Sergio Palao',
      authorUrl: 'https://arasaac.org/',
      sourceUrl: `https://arasaac.org/pictograms/${id}`,
      repoKey: 'arasaac'
    },
    usageCount: 0,
    lastUsedAt: Date.now()
  };
}

function normalizeOpenSymbolsImageUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    const hostname = parsed.hostname.toLowerCase();
    const allowedHost = OPENSYMBOLS_IMAGE_HOST_SUFFIXES.some(
      suffix => hostname === suffix || hostname.endsWith(`.${suffix}`)
    );

    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      !allowedHost
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

function createOpenSymbolsImageToken(imageUrl, secret) {
  const normalizedUrl = normalizeOpenSymbolsImageUrl(imageUrl);
  if (!normalizedUrl || !secret) return null;

  const payload = encodeBase64Url(normalizedUrl);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .slice(0, OPENSYMBOLS_SIGNATURE_LENGTH);
  return `${payload}.${signature}`;
}

function readOpenSymbolsImageToken(value, secret) {
  const token = String(value || '').trim();
  const match = token.match(/^([A-Za-z0-9_-]+)\.([a-f0-9]{32})$/);
  if (!secret || !match || token.length > MAX_OPENSYMBOLS_TOKEN_LENGTH) {
    return null;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(match[1])
    .digest('hex')
    .slice(0, OPENSYMBOLS_SIGNATURE_LENGTH);
  const actualBuffer = Buffer.from(match[2], 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    return normalizeOpenSymbolsImageUrl(decodeBase64Url(match[1]));
  } catch (error) {
    return null;
  }
}

function resolveOpenSymbolsSourceUrl(item) {
  const detailsUrl = String(item.details_url || '').trim();
  if (detailsUrl.startsWith('/')) return `${OPENSYMBOLS_API}${detailsUrl}`;
  if (/^https?:\/\//i.test(detailsUrl)) return detailsUrl;

  const sourceUrl = String(item.source_url || '').trim();
  return /^https?:\/\//i.test(sourceUrl) ? sourceUrl : OPENSYMBOLS_API;
}

function buildOpenSymbolsPictogram(
  token,
  query,
  locale,
  item,
  opensymbolsSecret
) {
  const originalId = String(item.symbol_key || item.id || '').trim();
  const repoKey = String(item.repo_key || '').trim();
  const license = String(item.license || '').trim();
  const remoteImageUrl = normalizeOpenSymbolsImageUrl(item.image_url);
  const imageToken = createOpenSymbolsImageToken(
    remoteImageUrl,
    opensymbolsSecret
  );
  if (
    !originalId ||
    !OPENSYMBOLS_ALLOWED_REPOS.has(repoKey) ||
    !license ||
    !imageToken
  ) {
    return null;
  }

  return {
    id: stableId('opensymbols', originalId, token),
    imageUrl: `/pictograms/opensymbols/${imageToken}/image`,
    labels: {
      zh: [token],
      en: [
        locale === 'en'
          ? String(item.name || query).trim()
          : getEnglishFallback(token)
      ].filter(Boolean)
    },
    categoryId: 'daily',
    categoryIds: ['daily'],
    synonyms: [],
    source: {
      provider: 'opensymbols',
      originalId,
      name: `OpenSymbols / ${repoKey}`,
      license,
      licenseUrl: item.license_url || null,
      author: item.author || null,
      authorUrl: item.author_url || null,
      sourceUrl: resolveOpenSymbolsSourceUrl(item),
      repoKey
    },
    usageCount: 0,
    lastUsedAt: Date.now()
  };
}

function createPictogramSearch(options) {
  const http = (options && options.http) || axios;
  const timeoutMs = (options && options.timeoutMs) || REQUEST_TIMEOUT_MS;
  const now =
    options && typeof options.now === 'function' ? options.now : Date.now;
  const searchCacheTtlMs = normalizePositiveInteger(
    options && options.searchCacheTtlMs,
    DEFAULT_SEARCH_CACHE_TTL_MS
  );
  const negativeCacheTtlMs = normalizePositiveInteger(
    options && options.negativeCacheTtlMs,
    DEFAULT_NEGATIVE_CACHE_TTL_MS
  );
  const maxSearchCacheEntries = normalizePositiveInteger(
    options && options.maxSearchCacheEntries,
    DEFAULT_MAX_SEARCH_CACHE_ENTRIES
  );
  const opensymbolsSecret = String(
    options &&
      Object.prototype.hasOwnProperty.call(options, 'opensymbolsSecret')
      ? options.opensymbolsSecret || ''
      : process.env.OPENSYMBOLS_SECRET || ''
  ).trim();
  const globalSymbols = createGlobalSymbolsProvider({
    http,
    timeoutMs,
    now,
    apiKey:
      options &&
      Object.prototype.hasOwnProperty.call(options, 'globalSymbolsApiKey')
        ? options.globalSymbolsApiKey
        : undefined,
    proxySecret:
      options &&
      Object.prototype.hasOwnProperty.call(options, 'globalSymbolsProxySecret')
        ? options.globalSymbolsProxySecret
        : undefined,
    apiV2: options && options.globalSymbolsApiV2,
    apiV1: options && options.globalSymbolsApiV1,
    cacheTtlMs: searchCacheTtlMs,
    negativeCacheTtlMs,
    maxCacheEntries: maxSearchCacheEntries
  });
  let opensymbolsAccessToken = null;
  let opensymbolsAccessTokenPromise = null;
  const searchCache = new Map();
  const inFlightSearches = new Map();

  function readCachedSearch(token) {
    const cached = searchCache.get(token);
    if (!cached) return { hit: false, pictograms: [] };
    if (cached.expiresAt <= now()) {
      searchCache.delete(token);
      return { hit: false, pictograms: [] };
    }

    searchCache.delete(token);
    searchCache.set(token, cached);
    return { hit: true, pictograms: cached.pictograms };
  }

  function cacheSearch(token, pictograms) {
    searchCache.delete(token);
    searchCache.set(token, {
      pictograms,
      expiresAt:
        now() + (pictograms.length ? searchCacheTtlMs : negativeCacheTtlMs)
    });
    while (searchCache.size > maxSearchCacheEntries) {
      searchCache.delete(searchCache.keys().next().value);
    }
  }

  async function requestArasaac(token, query, locale) {
    const normalizedQuery = normalizeArasaacQuery(query);
    if (!normalizedQuery) return [];
    const reviewedIds = locale === 'zh' ? getReviewedArasaacIds(token) : [];

    // Reuse cboard-ai-engine's ranked-search strategy, while preserving the
    // broader legacy endpoint as a compatibility fallback. Reviewed IDs come
    // from PicInterpreter's caregiver-verified evaluation set and stay first.
    for (const endpoint of ['bestsearch', 'search']) {
      const url = `${ARASAAC_API}/pictograms/${locale}/${endpoint}/${encodeURIComponent(
        normalizedQuery
      )}`;

      try {
        const response = await http.get(url, {
          timeout: timeoutMs,
          headers: { Accept: 'application/json' }
        });
        const items = response && response.data;
        if (!Array.isArray(items) || items.length === 0) {
          if (reviewedIds.length) break;
          continue;
        }

        const seen = new Set();
        return reviewedIds
          .concat(items.map(item => Number(item && (item._id || item.id))))
          .filter(id => {
            if (!Number.isInteger(id) || id <= 0 || seen.has(id)) return false;
            seen.add(id);
            return true;
          })
          .slice(0, MAX_PICTOGRAM_CANDIDATES_PER_TOKEN)
          .map(id => buildArasaacPictogram(token, normalizedQuery, locale, id));
      } catch (error) {
        if (reviewedIds.length) break;
        // Continue to the broad endpoint, then the existing language fallback.
      }
    }

    return reviewedIds.map(id =>
      buildArasaacPictogram(token, normalizedQuery, locale, id)
    );
  }

  async function getOpenSymbolsAccessToken(rejectedAccessToken = null) {
    if (!opensymbolsSecret) return null;
    if (opensymbolsAccessTokenPromise) {
      return opensymbolsAccessTokenPromise;
    }
    if (opensymbolsAccessToken && !rejectedAccessToken) {
      return opensymbolsAccessToken;
    }
    if (
      rejectedAccessToken &&
      opensymbolsAccessToken &&
      opensymbolsAccessToken !== rejectedAccessToken
    ) {
      return opensymbolsAccessToken;
    }
    if (opensymbolsAccessToken === rejectedAccessToken) {
      opensymbolsAccessToken = null;
    }

    const pending = Promise.resolve()
      .then(() =>
        http.post(`${OPENSYMBOLS_API}/api/v2/token`, null, {
          timeout: timeoutMs,
          params: { secret: opensymbolsSecret },
          headers: { Accept: 'application/json' }
        })
      )
      .then(response => {
        const accessToken = String(
          response && response.data && response.data.access_token
            ? response.data.access_token
            : ''
        ).trim();
        opensymbolsAccessToken = accessToken || null;
        return opensymbolsAccessToken;
      })
      .catch(() => null)
      .finally(() => {
        if (opensymbolsAccessTokenPromise === pending) {
          opensymbolsAccessTokenPromise = null;
        }
      });
    opensymbolsAccessTokenPromise = pending;
    return pending;
  }

  async function requestOpenSymbolsItems(query, locale, accessToken) {
    const response = await http.get(`${OPENSYMBOLS_API}/api/v2/symbols`, {
      timeout: timeoutMs,
      params: { q: query, locale, safe: 1 },
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`
      }
    });
    return response && response.data;
  }

  async function requestOpenSymbols(token, query, locale) {
    let accessToken = await getOpenSymbolsAccessToken();
    if (!accessToken) return [];

    let items;
    try {
      items = await requestOpenSymbolsItems(query, locale, accessToken);
    } catch (error) {
      if (!(error && error.response && error.response.status === 401)) {
        return [];
      }

      accessToken = await getOpenSymbolsAccessToken(accessToken);
      if (!accessToken) return [];
      try {
        items = await requestOpenSymbolsItems(query, locale, accessToken);
      } catch (retryError) {
        return [];
      }
    }

    if (!Array.isArray(items)) return [];
    const pictograms = [];
    const seen = new Set();
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const pictogram = buildOpenSymbolsPictogram(
        token,
        query,
        locale,
        item,
        opensymbolsSecret
      );
      if (!pictogram || seen.has(pictogram.id)) continue;
      seen.add(pictogram.id);
      pictograms.push(pictogram);
      if (pictograms.length >= MAX_PICTOGRAM_CANDIDATES_PER_TOKEN) break;
    }
    return pictograms;
  }

  async function searchOpenSymbols(token) {
    const chineseResult = await requestOpenSymbols(token, token, 'zh');
    if (chineseResult.length) return chineseResult;

    const fallback = getEnglishFallback(token);
    if (!fallback) return [];
    return requestOpenSymbols(token, fallback, 'en');
  }

  async function requestGlobalSymbols(token, query, locale) {
    const items = await globalSymbols.searchRuntimePictograms({
      token,
      query,
      locale,
      limit: MAX_PICTOGRAM_CANDIDATES_PER_TOKEN
    });
    return items.map(item => ({
      id: stableId('globalsymbols', item.originalId, token),
      imageUrl: item.imageUrl,
      labels: {
        zh: [token],
        en: [locale === 'en' ? item.label : getEnglishFallback(token)].filter(
          Boolean
        )
      },
      categoryId: 'daily',
      categoryIds: ['daily'],
      synonyms: [],
      source: item.source,
      usageCount: 0,
      lastUsedAt: Date.now()
    }));
  }

  async function searchGlobalSymbols(token) {
    const chineseResult = await requestGlobalSymbols(token, token, 'zh');
    if (chineseResult.length) return chineseResult;

    const fallback = getEnglishFallback(token);
    if (!fallback) return [];
    return requestGlobalSymbols(token, fallback, 'en');
  }

  async function searchOne(token) {
    const chineseResult = await requestArasaac(token, token, 'zh');
    if (chineseResult.length) return chineseResult;

    const fallback = getEnglishFallback(token);
    if (fallback) {
      const englishResult = await requestArasaac(token, fallback, 'en');
      if (englishResult.length) return englishResult;
    }

    const globalSymbolsResult = await searchGlobalSymbols(token);
    if (globalSymbolsResult.length) return globalSymbolsResult;

    return searchOpenSymbols(token);
  }

  async function searchOneCached(token) {
    const cached = readCachedSearch(token);
    if (cached.hit) return cached.pictograms;
    if (inFlightSearches.has(token)) {
      return inFlightSearches.get(token);
    }

    const pending = searchOne(token)
      .then(pictograms => {
        const normalized = (Array.isArray(pictograms) ? pictograms : [])
          .map(pictogram => {
            const source =
              pictogram &&
              normalizePublicPictogramAttribution(pictogram.source);
            return pictogram && source ? { ...pictogram, source } : null;
          })
          .filter(Boolean)
          .slice(0, MAX_PICTOGRAM_CANDIDATES_PER_TOKEN);
        cacheSearch(token, normalized);
        return normalized;
      })
      .finally(() => {
        if (inFlightSearches.get(token) === pending) {
          inFlightSearches.delete(token);
        }
      });
    inFlightSearches.set(token, pending);
    return pending;
  }

  async function searchRuntimePictograms(tokens) {
    const results = [];

    for (const token of normalizeTokens(tokens)) {
      const pictograms = await searchOneCached(token);
      pictograms.forEach(pictogram => results.push({ token, pictogram }));
    }

    return results;
  }

  async function loadArasaacImage(id) {
    const normalizedId = String(id || '').trim();
    if (!/^\d{1,12}$/.test(normalizedId)) {
      throw createHttpError(400, 'Invalid ARASAAC pictogram id');
    }

    const url = `${ARASAAC_STATIC}/${normalizedId}/${normalizedId}_300.png`;
    let response;

    try {
      response = await http.get(url, {
        timeout: timeoutMs,
        responseType: 'arraybuffer',
        maxContentLength: MAX_IMAGE_BYTES,
        maxBodyLength: MAX_IMAGE_BYTES,
        headers: { Accept: 'image/png' }
      });
    } catch (error) {
      throw createHttpError(502, 'Unable to load ARASAAC pictogram');
    }

    const contentType = String(
      (response.headers && response.headers['content-type']) || 'image/png'
    ).split(';')[0];
    const buffer = Buffer.from(response.data || []);

    if (!contentType.startsWith('image/') || buffer.length > MAX_IMAGE_BYTES) {
      throw createHttpError(502, 'Invalid ARASAAC pictogram response');
    }

    return { buffer, contentType };
  }

  async function loadOpenSymbolsImage(token) {
    if (!opensymbolsSecret) {
      throw createHttpError(503, 'OpenSymbols search is not configured');
    }

    const url = readOpenSymbolsImageToken(token, opensymbolsSecret);
    if (!url) {
      throw createHttpError(400, 'Invalid OpenSymbols image token');
    }

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
      throw createHttpError(502, 'Unable to load OpenSymbols pictogram');
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
      throw createHttpError(502, 'Invalid OpenSymbols pictogram response');
    }

    try {
      return await normalizePublicPictogramImage(buffer);
    } catch (error) {
      throw createHttpError(502, 'Invalid OpenSymbols pictogram response');
    }
  }

  return {
    loadArasaacImage,
    loadGlobalSymbolsImage: globalSymbols.loadImage,
    loadOpenSymbolsImage,
    searchGlobalSymbolsLabels: globalSymbols.searchLabels,
    searchRuntimePictograms
  };
}

const defaultSearch = createPictogramSearch();

module.exports = {
  MAX_QUERY_TOKENS,
  MAX_TOKEN_LENGTH,
  MAX_PICTOGRAM_CANDIDATES_PER_TOKEN,
  createPictogramSearch,
  normalizeTokens,
  loadArasaacImage: defaultSearch.loadArasaacImage,
  loadGlobalSymbolsImage: defaultSearch.loadGlobalSymbolsImage,
  loadOpenSymbolsImage: defaultSearch.loadOpenSymbolsImage,
  searchGlobalSymbolsLabels: defaultSearch.searchGlobalSymbolsLabels,
  searchRuntimePictograms: defaultSearch.searchRuntimePictograms
};

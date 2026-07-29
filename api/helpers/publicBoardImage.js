'use strict';

const axios = require('axios');
const config = require('../../config');
const {
  PublicBoardLibraryError,
  findPublicBoard
} = require('./publicBoardLibrary');
const {
  MAX_PICTOGRAM_IMAGE_BYTES,
  normalizePublicPictogramImage
} = require('./pictogramImage');

const MAX_PUBLIC_BOARD_TILE_ID_LENGTH = 120;
const MAX_PUBLIC_BOARD_IMAGE_URL_LENGTH = 2048;
const PUBLIC_BOARD_IMAGE_TIMEOUT_MS = 10000;
const PUBLIC_BOARD_IMAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_PUBLIC_BOARD_IMAGE_CACHE_ENTRIES = 100;
const MAX_PUBLIC_BOARD_IMAGE_CACHE_BYTES = 20 * 1024 * 1024;

function normalizeHost(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = text.includes('://')
      ? new URL(text)
      : new URL(`https://${text}`);
    return url.protocol === 'https:' && !url.port
      ? url.hostname.toLocaleLowerCase()
      : '';
  } catch (error) {
    return '';
  }
}

function getAllowedPublicBoardImageHosts(values = {}) {
  const additionalHosts = Array.isArray(values.additionalHosts)
    ? values.additionalHosts
    : String(
        values.additionalHosts || process.env.PUBLIC_BOARD_IMAGE_HOSTS || ''
      ).split(',');
  return new Set(
    [
      values.blobHost || config.CBOARD_PRODUCTION_BLOB_CONTAINER_HOSTNAME,
      values.cdnHost || config.AZURE_CDN_URL,
      ...additionalHosts
    ]
      .map(normalizeHost)
      .filter(Boolean)
  );
}

function validatePublicBoardImageUrl(value, allowedHosts) {
  const text = String(value || '').trim();
  if (!text || text.length > MAX_PUBLIC_BOARD_IMAGE_URL_LENGTH) return null;
  try {
    const url = new URL(text);
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      !allowedHosts.has(url.hostname.toLocaleLowerCase())
    ) {
      return null;
    }
    return url;
  } catch (error) {
    return null;
  }
}

function findPublicBoardTile(board, tileId) {
  const normalizedId = String(tileId || '').trim();
  if (!normalizedId || normalizedId.length > MAX_PUBLIC_BOARD_TILE_ID_LENGTH) {
    return null;
  }
  const source =
    board && typeof board.toJSON === 'function' ? board.toJSON() : board;
  return (
    source &&
    Array.isArray(source.tiles) &&
    source.tiles.find(
      tile => String((tile && tile.id) || '').trim() === normalizedId
    )
  );
}

function createPublicBoardImageLoader(defaultOptions = {}) {
  const cache = new Map();
  const inFlight = new Map();
  let cachedBytes = 0;

  function readCachedImage(key, now) {
    const cached = cache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= now) {
      cache.delete(key);
      cachedBytes -= cached.size;
      return null;
    }
    cache.delete(key);
    cache.set(key, cached);
    return cached.image;
  }

  function cacheImage(key, image, options) {
    const size = image.buffer.length;
    if (!size || size > options.maxCacheBytes) return;
    const previous = cache.get(key);
    if (previous) {
      cachedBytes -= previous.size;
      cache.delete(key);
    }
    cache.set(key, {
      image,
      size,
      expiresAt: options.now() + options.cacheTtlMs
    });
    cachedBytes += size;
    while (
      cache.size > options.maxCacheEntries ||
      cachedBytes > options.maxCacheBytes
    ) {
      const oldestKey = cache.keys().next().value;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      cachedBytes -= oldest.size;
    }
  }

  async function loadPublicBoardTileImage(
    model,
    boardId,
    tileId,
    callOptions = {}
  ) {
    const values = { ...defaultOptions, ...callOptions };
    const options = {
      ...values,
      now: values.now || Date.now,
      cacheTtlMs: values.cacheTtlMs || PUBLIC_BOARD_IMAGE_CACHE_TTL_MS,
      maxCacheEntries:
        values.maxCacheEntries || MAX_PUBLIC_BOARD_IMAGE_CACHE_ENTRIES,
      maxCacheBytes: values.maxCacheBytes || MAX_PUBLIC_BOARD_IMAGE_CACHE_BYTES
    };
    const loadBoard =
      options.findPublicBoard || (id => findPublicBoard(model, id));
    const board = await loadBoard(boardId);
    if (!board) {
      throw new PublicBoardLibraryError(
        'Public board does not exist',
        404,
        'PUBLIC_BOARD_NOT_FOUND'
      );
    }

    const tile = findPublicBoardTile(board, tileId);
    if (!tile || !tile.image) {
      throw new PublicBoardLibraryError(
        'Public board image does not exist',
        404,
        'PUBLIC_BOARD_IMAGE_NOT_FOUND'
      );
    }

    const allowedHosts =
      options.allowedHosts || getAllowedPublicBoardImageHosts(options);
    const imageUrl = validatePublicBoardImageUrl(tile.image, allowedHosts);
    if (!imageUrl) {
      throw new PublicBoardLibraryError(
        'Public board image host is not available for offline import',
        422,
        'PUBLIC_BOARD_IMAGE_HOST_NOT_ALLOWED'
      );
    }

    const key = JSON.stringify([
      String(boardId || '').trim(),
      String(tileId || '').trim(),
      imageUrl.href
    ]);
    const cached = readCachedImage(key, options.now());
    if (cached) return cached;
    if (inFlight.has(key)) return inFlight.get(key);

    const pending = Promise.resolve()
      .then(async () => {
        const http = options.http || axios;
        let response;
        try {
          response = await http.get(imageUrl.href, {
            timeout: options.timeoutMs || PUBLIC_BOARD_IMAGE_TIMEOUT_MS,
            responseType: 'arraybuffer',
            maxContentLength: MAX_PICTOGRAM_IMAGE_BYTES,
            maxBodyLength: MAX_PICTOGRAM_IMAGE_BYTES,
            maxRedirects: 0,
            headers: { Accept: 'image/*' }
          });
        } catch (error) {
          throw new PublicBoardLibraryError(
            'Unable to load public board image',
            502,
            'PUBLIC_BOARD_IMAGE_LOAD_FAILED'
          );
        }

        const contentType = String(
          (response && response.headers && response.headers['content-type']) ||
            ''
        ).split(';')[0];
        const buffer = Buffer.from((response && response.data) || []);
        if (
          !contentType.startsWith('image/') ||
          !buffer.length ||
          buffer.length > MAX_PICTOGRAM_IMAGE_BYTES
        ) {
          throw new PublicBoardLibraryError(
            'Invalid public board image response',
            502,
            'PUBLIC_BOARD_IMAGE_INVALID'
          );
        }

        let image;
        try {
          image = await (
            options.normalizeImage || normalizePublicPictogramImage
          )(buffer);
        } catch (error) {
          throw new PublicBoardLibraryError(
            'Invalid public board image response',
            502,
            'PUBLIC_BOARD_IMAGE_INVALID'
          );
        }
        if (
          !image ||
          !Buffer.isBuffer(image.buffer) ||
          image.contentType !== 'image/png'
        ) {
          throw new PublicBoardLibraryError(
            'Invalid public board image response',
            502,
            'PUBLIC_BOARD_IMAGE_INVALID'
          );
        }
        cacheImage(key, image, options);
        return image;
      })
      .finally(() => {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      });
    inFlight.set(key, pending);
    return pending;
  }

  return { loadPublicBoardTileImage };
}

const defaultLoader = createPublicBoardImageLoader();

module.exports = {
  MAX_PUBLIC_BOARD_IMAGE_CACHE_BYTES,
  MAX_PUBLIC_BOARD_IMAGE_CACHE_ENTRIES,
  MAX_PUBLIC_BOARD_IMAGE_URL_LENGTH,
  MAX_PUBLIC_BOARD_TILE_ID_LENGTH,
  PUBLIC_BOARD_IMAGE_CACHE_TTL_MS,
  PUBLIC_BOARD_IMAGE_TIMEOUT_MS,
  createPublicBoardImageLoader,
  findPublicBoardTile,
  getAllowedPublicBoardImageHosts,
  loadPublicBoardTileImage: defaultLoader.loadPublicBoardTileImage,
  normalizeHost,
  validatePublicBoardImageUrl
};

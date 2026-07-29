'use strict';

const PUBLIC_BOARD_BUNDLE_FORMAT = 'cboard-public-board-bundle';
const PUBLIC_BOARD_BUNDLE_VERSION = 1;
const MAX_PUBLIC_BUNDLE_BOARDS = 100;
const MAX_PUBLIC_BUNDLE_TILES = 5000;
const CBOARD_SOURCE_URL = 'https://github.com/cboard-org/cboard';

class PublicBoardLibraryError extends Error {
  constructor(message, statusCode = 400, code = 'PUBLIC_BOARD_INVALID') {
    super(message);
    this.name = 'PublicBoardLibraryError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeId(value) {
  return String(value || '').trim();
}

function toPlainBoard(value) {
  if (!value) return null;
  const source =
    typeof value.toJSON === 'function'
      ? value.toJSON()
      : typeof value.toObject === 'function'
      ? value.toObject()
      : value;
  return JSON.parse(JSON.stringify(source));
}

function sanitizePublicBoard(value) {
  const board = toPlainBoard(value);
  if (!board) return null;

  const id = normalizeId(board.id || board._id);
  delete board._id;
  delete board.__v;
  delete board.email;
  return {
    ...board,
    id,
    isPublic: true,
    tiles: Array.isArray(board.tiles) ? board.tiles : []
  };
}

async function resolveQuery(query) {
  if (!query) return null;
  let current = query;
  if (typeof current.lean === 'function') current = current.lean();
  return typeof current.exec === 'function' ? current.exec() : current;
}

async function findPublicBoard(model, id) {
  if (!model || typeof model.findOne !== 'function') {
    throw new TypeError('A board model with findOne is required');
  }
  try {
    return await resolveQuery(
      model.findOne({ _id: normalizeId(id), isPublic: true })
    );
  } catch (error) {
    return null;
  }
}

function linkedBoardId(tile) {
  return normalizeId(
    tile &&
      (tile.loadBoardId ||
        tile.loadBoard ||
        (tile.load_board && (tile.load_board.id || tile.load_board.path)))
  );
}

function publicBoardImagePath(boardId, tileId) {
  const normalizedBoardId = normalizeId(boardId);
  const normalizedTileId = normalizeId(tileId);
  if (!normalizedBoardId || !normalizedTileId) return '';
  return (
    `/board/public/${encodeURIComponent(normalizedBoardId)}/tile/` +
    `${encodeURIComponent(normalizedTileId)}/image`
  );
}

async function buildPublicBoardBundle(model, rootBoardId, options = {}) {
  const maxBoards = options.maxBoards || MAX_PUBLIC_BUNDLE_BOARDS;
  const maxTiles = options.maxTiles || MAX_PUBLIC_BUNDLE_TILES;
  const loadBoard =
    options.findPublicBoard || (id => findPublicBoard(model, id));
  const rootId = normalizeId(rootBoardId);
  const queue = [rootId];
  const queued = new Set(queue);
  const unavailable = new Set();
  const boards = [];
  const boardIds = new Set();
  let tileCount = 0;

  while (queue.length) {
    if (boards.length >= maxBoards) {
      throw new PublicBoardLibraryError(
        `Public board bundle cannot contain more than ${maxBoards} boards`,
        413,
        'PUBLIC_BOARD_BUNDLE_TOO_LARGE'
      );
    }

    const id = queue.shift();
    const source = await loadBoard(id);
    if (!source) {
      if (id === rootId) {
        throw new PublicBoardLibraryError(
          'Public board does not exist',
          404,
          'PUBLIC_BOARD_NOT_FOUND'
        );
      }
      unavailable.add(id);
      continue;
    }

    const board = sanitizePublicBoard(source);
    if (!board || !board.id || boardIds.has(board.id)) continue;
    tileCount += board.tiles.length;
    if (tileCount > maxTiles) {
      throw new PublicBoardLibraryError(
        `Public board bundle cannot contain more than ${maxTiles} tiles`,
        413,
        'PUBLIC_BOARD_BUNDLE_TOO_LARGE'
      );
    }

    boards.push(board);
    boardIds.add(board.id);
    board.tiles.forEach(tile => {
      const nextId = linkedBoardId(tile);
      if (nextId && !queued.has(nextId)) {
        queued.add(nextId);
        queue.push(nextId);
      }
    });
  }

  const data = boards.map(board => ({
    ...board,
    tiles: board.tiles.map(tile => {
      const nextId = linkedBoardId(tile);
      const sanitizedTile = { ...tile };
      if (nextId && !boardIds.has(nextId)) {
        delete sanitizedTile.loadBoard;
        delete sanitizedTile.loadBoardId;
        delete sanitizedTile.load_board;
        unavailable.add(nextId);
      }
      const imagePath = publicBoardImagePath(board.id, tile.id);
      if (normalizeId(tile.image) && imagePath) {
        sanitizedTile.offlineImagePath = imagePath;
      }
      return sanitizedTile;
    })
  }));
  const warnings = [
    'Public CBoard authors may not provide a per-image license; verify image rights before reuse.',
    'Remote image URLs are preserved and may require network access.',
    'Offline image copies are available only for configured CBoard image hosts.'
  ];
  if (unavailable.size) {
    warnings.push(
      'Unavailable or private linked boards were omitted and their links were removed.'
    );
  }

  return {
    format: PUBLIC_BOARD_BUNDLE_FORMAT,
    contractVersion: PUBLIC_BOARD_BUNDLE_VERSION,
    rootBoardId: rootId,
    source: 'cboard-public',
    sourceUrl: CBOARD_SOURCE_URL,
    licenseStatus: 'unknown',
    warnings,
    data,
    diagnostics: {
      boardCount: data.length,
      tileCount,
      unavailableLinkedBoardCount: unavailable.size
    }
  };
}

module.exports = {
  CBOARD_SOURCE_URL,
  MAX_PUBLIC_BUNDLE_BOARDS,
  MAX_PUBLIC_BUNDLE_TILES,
  PUBLIC_BOARD_BUNDLE_FORMAT,
  PUBLIC_BOARD_BUNDLE_VERSION,
  PublicBoardLibraryError,
  buildPublicBoardBundle,
  findPublicBoard,
  linkedBoardId,
  publicBoardImagePath,
  sanitizePublicBoard
};

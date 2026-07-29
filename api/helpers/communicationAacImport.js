'use strict';

const crypto = require('crypto');
const path = require('path');
const { resolveTouchChatCustomImages } = require('./touchChatCustomImages');

const AAC_IMPORT_FORMAT = 'picinterpreter-aac-conversion';
const AAC_IMPORT_CONTRACT_VERSION = 1;
const MAX_AAC_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_AAC_IMPORT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_AAC_IMPORT_PAGES = 500;
const MAX_AAC_IMPORT_BUTTONS = 20000;
const MAX_AAC_IMPORT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AAC_IMPORT_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_AAC_IMPORT_GRID_DIMENSION = 100;
const SQLITE_SIGNATURE = Buffer.from('SQLite format 3\0', 'binary');
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const SUPPORTED_AAC_IMPORT_FORMATS = Object.freeze(['snap', 'touchchat']);

class CommunicationAacImportError extends Error {
  constructor(message, statusCode = 400, code = 'AAC_IMPORT_INVALID') {
    super(message);
    this.name = 'CommunicationAacImportError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeSourceFormat(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!SUPPORTED_AAC_IMPORT_FORMATS.includes(normalized)) {
    throw new CommunicationAacImportError(
      'AAC import format must be snap or touchchat'
    );
  }
  return normalized;
}

function normalizeSourceFileName(value, format) {
  const fallback = format === 'snap' ? 'imported.sps' : 'imported.ce';
  const baseName = path
    .basename(String(value || fallback))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 120);
  return baseName || fallback;
}

function normalizeInputBuffer(buffer, format) {
  if (
    !Buffer.isBuffer(buffer) ||
    !buffer.length ||
    buffer.length > MAX_AAC_IMPORT_BYTES
  ) {
    throw new CommunicationAacImportError(
      'AAC import file must be non-empty and no larger than 20 MiB'
    );
  }
  const signature = format === 'snap' ? SQLITE_SIGNATURE : ZIP_SIGNATURE;
  if (
    buffer.length < signature.length ||
    !buffer.subarray(0, signature.length).equals(signature)
  ) {
    throw new CommunicationAacImportError(
      format === 'snap'
        ? 'Snap import must be an unencrypted SQLite .sps or .spb file'
        : 'TouchChat import must be a ZIP-based .ce file'
    );
  }
  return buffer;
}

function safePathPart(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

function normalizeColor(value) {
  const color = String(value || '').trim();
  const eightDigit = color.match(/^#([0-9a-f]{6})[0-9a-f]{2}$/i);
  if (eightDigit) return `#${eightDigit[1]}`;
  return /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
}

function buttonTargetPageId(button) {
  return String(
    button.targetPageId ||
      (button.semanticAction && button.semanticAction.targetId) ||
      ''
  );
}

function buttonVocalization(button) {
  if (
    button.semanticAction &&
    typeof button.semanticAction.text === 'string' &&
    button.semanticAction.text.trim()
  ) {
    return button.semanticAction.text.trim();
  }
  return String(button.message || button.label || '');
}

function occupiedGridBounds(page) {
  let rows = 0;
  let columns = 0;
  if (Array.isArray(page.grid)) {
    page.grid.forEach((row, rowIndex) => {
      if (!Array.isArray(row)) return;
      row.forEach((cell, columnIndex) => {
        if (!cell || !cell.id) return;
        rows = Math.max(rows, rowIndex + 1);
        columns = Math.max(columns, columnIndex + 1);
      });
    });
  }
  page.buttons.forEach(button => {
    const x = Number(button.x);
    const y = Number(button.y);
    if (Number.isInteger(x) && x >= 0) columns = Math.max(columns, x + 1);
    if (Number.isInteger(y) && y >= 0) rows = Math.max(rows, y + 1);
  });
  if (!rows || !columns) {
    columns = Math.max(
      1,
      Math.min(10, Math.ceil(Math.sqrt(Math.max(page.buttons.length, 1))))
    );
    rows = Math.max(1, Math.ceil(Math.max(page.buttons.length, 1) / columns));
  }
  if (
    rows > MAX_AAC_IMPORT_GRID_DIMENSION ||
    columns > MAX_AAC_IMPORT_GRID_DIMENSION
  ) {
    throw new CommunicationAacImportError(
      'AAC import contains an oversized page grid'
    );
  }
  return { rows, columns };
}

function createButtonIds(page) {
  const ids = new Map();
  const used = new Set();
  page.buttons.forEach((button, index) => {
    const baseId = String(button.id || `button-${index + 1}`);
    let id = baseId;
    let duplicateIndex = 2;
    while (used.has(id)) {
      id = `${baseId}--${duplicateIndex}`;
      duplicateIndex += 1;
    }
    used.add(id);
    ids.set(button, id);
  });
  return ids;
}

function createGridOrder(page, dimensions, buttonIds) {
  const order = Array.from({ length: dimensions.rows }, () =>
    Array.from({ length: dimensions.columns }, () => null)
  );
  if (Array.isArray(page.grid)) {
    page.grid.slice(0, dimensions.rows).forEach((row, rowIndex) => {
      if (!Array.isArray(row)) return;
      row.slice(0, dimensions.columns).forEach((cell, columnIndex) => {
        if (!cell) return;
        const id = buttonIds.get(cell) || String(cell.id || '');
        if (id) order[rowIndex][columnIndex] = id;
      });
    });
  }

  const placed = new Set(order.flat().filter(Boolean));
  page.buttons.forEach(button => {
    const id = buttonIds.get(button);
    if (!id || placed.has(id)) return;
    const x = Number(button.x);
    const y = Number(button.y);
    if (
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      x >= 0 &&
      y >= 0 &&
      x < dimensions.columns &&
      y < dimensions.rows &&
      !order[y][x]
    ) {
      order[y][x] = id;
      placed.add(id);
      return;
    }
    for (let row = 0; row < dimensions.rows; row += 1) {
      const column = order[row].findIndex(value => !value);
      if (column >= 0) {
        order[row][column] = id;
        placed.add(id);
        return;
      }
    }
  });
  return order;
}

function imageFromButton(button, state, images) {
  const dataUrl = String(button.image || button.resolvedImageEntry || '');
  const match = dataUrl.match(
    /^data:image\/(png|jpeg);base64,([a-z0-9+/=]+)$/i
  );
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_AAC_IMPORT_IMAGE_BYTES) return null;
  const key = crypto
    .createHash('sha256')
    .update(bytes)
    .digest('hex');
  if (state.imageIds.has(key)) return state.imageIds.get(key);

  state.totals.totalImageBytes += bytes.length;
  if (state.totals.totalImageBytes > MAX_AAC_IMPORT_TOTAL_IMAGE_BYTES) {
    throw new CommunicationAacImportError(
      'AAC import contains too much embedded image data'
    );
  }
  const id = `aac-image-${state.imageIds.size + 1}`;
  state.imageIds.set(key, id);
  images.push({ id, url: dataUrl });
  return id;
}

function createOpenBoard(page, locale, pathByPageId, state) {
  const buttons = Array.isArray(page.buttons) ? page.buttons : [];
  const normalizedPage = { ...page, buttons };
  const dimensions = occupiedGridBounds(normalizedPage);
  const buttonIds = createButtonIds(normalizedPage);
  const images = [];
  const imageState = { imageIds: new Map(), totals: state };
  const openBoardButtons = buttons.map(button => {
    const result = {
      id: buttonIds.get(button),
      label: String(button.label || ''),
      vocalization: buttonVocalization(button),
      background_color: normalizeColor(
        button.style && button.style.backgroundColor
      ),
      border_color: normalizeColor(button.style && button.style.borderColor),
      hidden: button.visibility === 'Hidden' || button.visibility === 'hidden'
    };
    const imageId = imageFromButton(button, imageState, images);
    if (imageId) result.image_id = imageId;
    const targetPageId = buttonTargetPageId(button);
    if (targetPageId && pathByPageId.has(targetPageId)) {
      result.load_board = { path: pathByPageId.get(targetPageId) };
    }
    return result;
  });

  return {
    format: 'open-board-0.1',
    id: String(page.id),
    locale: String(page.locale || locale || 'zh-CN'),
    name: String(page.name || 'Imported AAC board'),
    grid: {
      rows: dimensions.rows,
      columns: dimensions.columns,
      order: createGridOrder(normalizedPage, dimensions, buttonIds)
    },
    buttons: openBoardButtons,
    images,
    sounds: []
  };
}

function createDefaultProcessor(format) {
  if (format === 'snap') {
    const { SnapProcessor } = require('@willwade/aac-processors/snap');
    return new SnapProcessor(null, {
      preserveAllButtons: true,
      pageLayoutPreference: 'largest'
    });
  }
  const { TouchChatProcessor } = require('@willwade/aac-processors/touchchat');
  return new TouchChatProcessor({ preserveAllButtons: true });
}

async function convertCommunicationAacFile(
  { buffer, format, fileName, locale = 'zh-CN' } = {},
  {
    createProcessor = createDefaultProcessor,
    resolveTouchChatImages = resolveTouchChatCustomImages
  } = {}
) {
  const sourceFormat = normalizeSourceFormat(format);
  const sourceFileName = normalizeSourceFileName(fileName, sourceFormat);
  const input = normalizeInputBuffer(buffer, sourceFormat);
  let tree;
  try {
    tree = await createProcessor(sourceFormat).loadIntoTree(input);
  } catch (error) {
    throw new CommunicationAacImportError(
      `Unable to read the ${sourceFormat} AAC file`,
      422,
      'AAC_IMPORT_PARSE_FAILED'
    );
  }
  const warnings = [];
  if (sourceFormat === 'touchchat') {
    try {
      const imageResult = resolveTouchChatImages(input, tree);
      if (imageResult.skippedImageCount) {
        warnings.push(
          `${imageResult.skippedImageCount} unsupported or oversized TouchChat custom images were skipped`
        );
      }
    } catch (_error) {
      warnings.push(
        'TouchChat text and layout were imported, but custom images could not be read'
      );
    }
  }

  const pages = Object.values((tree && tree.pages) || {});
  if (!pages.length || pages.length > MAX_AAC_IMPORT_PAGES) {
    throw new CommunicationAacImportError(
      'AAC import has an invalid page count'
    );
  }
  const buttonCount = pages.reduce(
    (total, page) =>
      total + (Array.isArray(page.buttons) ? page.buttons.length : 0),
    0
  );
  if (buttonCount > MAX_AAC_IMPORT_BUTTONS) {
    throw new CommunicationAacImportError(
      'AAC import contains too many buttons'
    );
  }

  const orderedPages = tree.rootId
    ? pages
        .filter(page => String(page.id) === String(tree.rootId))
        .concat(pages.filter(page => String(page.id) !== String(tree.rootId)))
    : pages;
  const baseName = safePathPart(
    sourceFileName.replace(/\.(sps|spb|ce)$/i, ''),
    sourceFormat
  );
  const pathByPageId = new Map(
    orderedPages.map((page, index) => [
      String(page.id),
      `boards/${baseName}-${index + 1}-${safePathPart(page.id, 'board')}.obf`
    ])
  );
  const state = { totalImageBytes: 0 };
  const documents = orderedPages.map(page => ({
    path: pathByPageId.get(String(page.id)),
    board: createOpenBoard(page, locale, pathByPageId, state)
  }));
  const response = {
    format: AAC_IMPORT_FORMAT,
    contractVersion: AAC_IMPORT_CONTRACT_VERSION,
    sourceFormat,
    sourceFileName,
    capabilities: {
      text: true,
      layout: true,
      embeddedRasterImages:
        sourceFormat === 'snap' || sourceFormat === 'touchchat',
      touchChatCustomImages: sourceFormat === 'touchchat'
    },
    warnings,
    documents
  };
  if (
    Buffer.byteLength(JSON.stringify(response), 'utf8') >
    MAX_AAC_IMPORT_OUTPUT_BYTES
  ) {
    throw new CommunicationAacImportError(
      'AAC import output is too large',
      413,
      'AAC_IMPORT_OUTPUT_TOO_LARGE'
    );
  }
  return response;
}

function createCommunicationAacImportService({
  converter = convertCommunicationAacFile,
  maxConcurrent = 2
} = {}) {
  let active = 0;
  return async input => {
    if (active >= maxConcurrent) {
      throw new CommunicationAacImportError(
        'AAC import service is busy; retry shortly',
        429,
        'AAC_IMPORT_BUSY'
      );
    }
    active += 1;
    try {
      return await converter(input);
    } finally {
      active -= 1;
    }
  };
}

module.exports = {
  AAC_IMPORT_CONTRACT_VERSION,
  AAC_IMPORT_FORMAT,
  CommunicationAacImportError,
  MAX_AAC_IMPORT_BYTES,
  MAX_AAC_IMPORT_BUTTONS,
  MAX_AAC_IMPORT_PAGES,
  SUPPORTED_AAC_IMPORT_FORMATS,
  convertCommunicationAacFile,
  createCommunicationAacImportService,
  normalizeInputBuffer,
  normalizeSourceFormat
};

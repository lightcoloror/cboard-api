'use strict';

// Image-linking queries are adapted from Bravo AAC's TouchChat importer:
// https://github.com/OSUBlakester/BravoGCPCopilot/blob/e23ec815d9e9cd1985441ae1fc2b62467b6562ee/touchchat_ce_parser.py
// Copyright 2024 Blake Thomas, Apache-2.0. This Node adaptation avoids archive
// extraction and only resolves raster images embedded in Images.c4s.

const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');

const MAX_DATABASE_BYTES = 40 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

class TouchChatCustomImageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TouchChatCustomImageError';
  }
}

function findArchiveEntry(zip, predicate) {
  return zip
    .getEntries()
    .find(entry => !entry.isDirectory && predicate(entry.entryName));
}

function entryBaseName(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .toLowerCase();
}

function readBoundedEntry(entry, description) {
  if (!entry) return null;
  if (!entry.header || entry.header.size > MAX_DATABASE_BYTES) {
    throw new TouchChatCustomImageError(
      `${description} is larger than the supported database limit`
    );
  }
  const data = entry.getData();
  if (!data.length || data.length > MAX_DATABASE_BYTES) {
    throw new TouchChatCustomImageError(
      `${description} is empty or larger than the supported database limit`
    );
  }
  return data;
}

function rasterDataUrl(value) {
  const data = Buffer.from(value || []);
  if (!data.length || data.length > MAX_IMAGE_BYTES) return null;
  if (data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return {
      bytes: data.length,
      dataUrl: `data:image/png;base64,${data.toString('base64')}`
    };
  }
  if (data.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return {
      bytes: data.length,
      dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`
    };
  }
  return null;
}

function databaseRows(vocabularyDatabase, imageDatabase) {
  const symbolLinks = vocabularyDatabase
    .prepare(
      `
        SELECT DISTINCT sl.id AS symbol_link_id, sl.rid AS symbol_rid
        FROM buttons b
        JOIN symbol_links sl ON sl.id = b.symbol_link_id
        WHERE sl.rid IS NOT NULL AND TRIM(sl.rid) <> ''
      `
    )
    .all();
  if (!symbolLinks.length) {
    return { imagesByLinkId: new Map(), skippedImageCount: 0 };
  }

  const linkIdsByRid = new Map();
  symbolLinks.forEach(row => {
    const rid = String(row.symbol_rid);
    const ids = linkIdsByRid.get(rid) || [];
    ids.push(String(row.symbol_link_id));
    linkIdsByRid.set(rid, ids);
  });

  const imagesByLinkId = new Map();
  let totalImageBytes = 0;
  let skippedImageCount = 0;
  const imageRows = imageDatabase
    .prepare(
      `
        SELECT rid, data
        FROM symbols
        WHERE rid IS NOT NULL AND data IS NOT NULL
      `
    )
    .iterate();
  for (const row of imageRows) {
    const linkIds = linkIdsByRid.get(String(row.rid));
    if (!linkIds) continue;
    const image = rasterDataUrl(row.data);
    if (!image || totalImageBytes + image.bytes > MAX_TOTAL_IMAGE_BYTES) {
      skippedImageCount += 1;
      continue;
    }
    totalImageBytes += image.bytes;
    linkIds.forEach(linkId => imagesByLinkId.set(linkId, image.dataUrl));
  }

  return { imagesByLinkId, skippedImageCount };
}

function applyImagesToTree(tree, imagesByLinkId) {
  let matchedButtonCount = 0;
  Object.values((tree && tree.pages) || {}).forEach(page => {
    (Array.isArray(page.buttons) ? page.buttons : []).forEach(button => {
      const symbolLinkId = String(
        button.semantic_id || button.semanticId || ''
      );
      const image = imagesByLinkId.get(symbolLinkId);
      if (!image) return;
      button.image = image;
      matchedButtonCount += 1;
    });
  });
  return matchedButtonCount;
}

function resolveTouchChatCustomImages(buffer, tree) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (_error) {
    throw new TouchChatCustomImageError(
      'TouchChat custom image archive could not be read'
    );
  }

  const vocabularyEntry = findArchiveEntry(zip, name =>
    entryBaseName(name).endsWith('.c4v')
  );
  const imagesEntry = findArchiveEntry(
    zip,
    name => entryBaseName(name) === 'images.c4s'
  );
  if (!vocabularyEntry || !imagesEntry) {
    return {
      embeddedImageCount: 0,
      matchedButtonCount: 0,
      skippedImageCount: 0
    };
  }

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'cboard-touchchat-')
  );
  const vocabularyPath = path.join(temporaryDirectory, 'vocabulary.c4v');
  const imagesPath = path.join(temporaryDirectory, 'Images.c4s');
  let vocabularyDatabase;
  let imageDatabase;
  try {
    fs.writeFileSync(
      vocabularyPath,
      readBoundedEntry(vocabularyEntry, 'TouchChat vocabulary database')
    );
    fs.writeFileSync(
      imagesPath,
      readBoundedEntry(imagesEntry, 'TouchChat image database')
    );
    vocabularyDatabase = new Database(vocabularyPath, {
      readonly: true,
      fileMustExist: true
    });
    imageDatabase = new Database(imagesPath, {
      readonly: true,
      fileMustExist: true
    });
    const { imagesByLinkId, skippedImageCount } = databaseRows(
      vocabularyDatabase,
      imageDatabase
    );
    return {
      embeddedImageCount: new Set(imagesByLinkId.values()).size,
      matchedButtonCount: applyImagesToTree(tree, imagesByLinkId),
      skippedImageCount
    };
  } catch (error) {
    if (error instanceof TouchChatCustomImageError) throw error;
    throw new TouchChatCustomImageError(
      'TouchChat custom image databases could not be read'
    );
  } finally {
    if (vocabularyDatabase) vocabularyDatabase.close();
    if (imageDatabase) imageDatabase.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

module.exports = {
  MAX_DATABASE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  TouchChatCustomImageError,
  resolveTouchChatCustomImages
};

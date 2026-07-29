'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');
const { expect } = require('chai');
const {
  resolveTouchChatCustomImages
} = require('../../api/helpers/touchChatCustomImages');

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function createTouchChatArchive(imageData = PNG_BYTES) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'cboard-touchchat-test-')
  );
  const vocabularyPath = path.join(directory, 'fixture.c4v');
  const imagesPath = path.join(directory, 'Images.c4s');
  const vocabulary = new Database(vocabularyPath);
  const images = new Database(imagesPath);
  try {
    vocabulary.exec(`
      CREATE TABLE symbol_links (
        id INTEGER PRIMARY KEY,
        rid TEXT NOT NULL
      );
      CREATE TABLE buttons (
        id INTEGER PRIMARY KEY,
        symbol_link_id INTEGER
      );
      INSERT INTO symbol_links (id, rid) VALUES (7, 'custom-apple');
      INSERT INTO buttons (id, symbol_link_id) VALUES (11, 7);
    `);
    images.exec(`
      CREATE TABLE symbols (
        id INTEGER PRIMARY KEY,
        rid TEXT NOT NULL,
        compressed INTEGER NOT NULL,
        type INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        data BLOB NOT NULL
      );
    `);
    images
      .prepare(
        `
          INSERT INTO symbols
            (id, rid, compressed, type, width, height, data)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(1, 'custom-apple', 0, 1, 1, 1, imageData);
  } finally {
    vocabulary.close();
    images.close();
  }

  const archive = new AdmZip();
  archive.addLocalFile(vocabularyPath);
  archive.addLocalFile(imagesPath);
  const buffer = archive.toBuffer();
  fs.rmSync(directory, { recursive: true, force: true });
  return buffer;
}

function createTree() {
  return {
    pages: {
      home: {
        buttons: [{ id: '11', label: '苹果', semantic_id: 7 }]
      }
    }
  };
}

describe('TouchChat custom image resolution', function() {
  it('reuses the Images.c4s symbol RID linkage for embedded PNG images', function() {
    const tree = createTree();
    const result = resolveTouchChatCustomImages(createTouchChatArchive(), tree);

    expect(result).to.deep.equal({
      embeddedImageCount: 1,
      matchedButtonCount: 1,
      skippedImageCount: 0
    });
    expect(tree.pages.home.buttons[0].image).to.match(
      /^data:image\/png;base64,/
    );
  });

  it('skips an unsupported embedded payload without removing the button', function() {
    const tree = createTree();
    const result = resolveTouchChatCustomImages(
      createTouchChatArchive(Buffer.from('not-an-image')),
      tree
    );

    expect(result).to.deep.equal({
      embeddedImageCount: 0,
      matchedButtonCount: 0,
      skippedImageCount: 1
    });
    expect(tree.pages.home.buttons[0]).not.to.have.property('image');
  });
});

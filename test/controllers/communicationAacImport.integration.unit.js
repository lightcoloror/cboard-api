'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');
const chai = require('chai');
const {
  AACButton,
  AACPage,
  AACTree
} = require('@willwade/aac-processors/node');
const { SnapProcessor } = require('@willwade/aac-processors/snap');
const { TouchChatProcessor } = require('@willwade/aac-processors/touchchat');
const {
  convertCommunicationAacFile
} = require('../../api/helpers/communicationAacImport');

const expect = chai.expect;
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function createTree() {
  const tree = new AACTree();
  const page = new AACPage({
    id: 'home',
    name: '核心表达',
    grid: { columns: 2, rows: 1 },
    locale: 'zh-CN'
  });
  page.addButton(
    new AACButton({
      id: 'drink',
      label: '喝水',
      message: '我想喝水',
      x: 0,
      y: 0
    })
  );
  page.addButton(
    new AACButton({
      id: 'toilet',
      label: '厕所',
      message: '我要去厕所',
      x: 1,
      y: 0
    })
  );
  tree.addPage(page);
  tree.rootId = page.id;
  return tree;
}

function attachTouchChatCustomImage(sourcePath, directory) {
  const archive = new AdmZip(sourcePath);
  const vocabularyEntry = archive
    .getEntries()
    .find(entry => entry.entryName.endsWith('.c4v'));
  const vocabularyPath = path.join(directory, 'fixture-with-image.c4v');
  const imagesPath = path.join(directory, 'Images.c4s');
  fs.writeFileSync(vocabularyPath, vocabularyEntry.getData());

  const vocabulary = new Database(vocabularyPath);
  const images = new Database(imagesPath);
  try {
    vocabulary.exec(`
      CREATE TABLE symbol_links (
        id INTEGER PRIMARY KEY,
        rid TEXT NOT NULL,
        feature INTEGER NOT NULL
      );
    `);
    const link = vocabulary
      .prepare('INSERT INTO symbol_links (rid, feature) VALUES (?, ?)')
      .run('custom-drink', 0);
    vocabulary
      .prepare(
        `
          UPDATE buttons
          SET symbol_link_id = ?
          WHERE id = (SELECT MIN(id) FROM buttons)
        `
      )
      .run(link.lastInsertRowid);
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
      .run(1, 'custom-drink', 0, 1, 1, 1, PNG_BYTES);
  } finally {
    vocabulary.close();
    images.close();
  }

  archive.deleteFile(vocabularyEntry.entryName);
  archive.addFile(vocabularyEntry.entryName, fs.readFileSync(vocabularyPath));
  archive.addFile('Images.c4s', fs.readFileSync(imagesPath));
  archive.writeZip(sourcePath);
}

describe('Communication AAC import official processor integration', function() {
  this.timeout(30000);

  let tempDirectory;
  let originalWarn;

  beforeEach(function() {
    tempDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'cboard-aac-import-')
    );
    originalWarn = console.warn;
    console.warn = () => {};
  });

  afterEach(function() {
    console.warn = originalWarn;
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  for (const fixture of [
    { format: 'snap', extension: '.sps', Processor: SnapProcessor },
    { format: 'touchchat', extension: '.ce', Processor: TouchChatProcessor }
  ]) {
    it(`round-trips a real ${fixture.format} file into Open Board`, async function() {
      const sourcePath = path.join(
        tempDirectory,
        `fixture${fixture.extension}`
      );
      const processor =
        fixture.format === 'snap'
          ? new fixture.Processor(null, { preserveAllButtons: true })
          : new fixture.Processor({ preserveAllButtons: true });
      await processor.saveFromTree(createTree(), sourcePath);
      if (fixture.format === 'touchchat') {
        attachTouchChatCustomImage(sourcePath, tempDirectory);
      }
      const source = fs.readFileSync(sourcePath);

      const result = await convertCommunicationAacFile({
        buffer: source,
        format: fixture.format,
        fileName: path.basename(sourcePath),
        locale: 'zh-CN'
      });

      expect(result.sourceFormat).to.equal(fixture.format);
      expect(result.documents).to.have.length(1);
      expect(result.documents[0].board).to.deep.include({
        format: 'open-board-0.1',
        id: 'home',
        name: '核心表达'
      });
      expect(result.documents[0].board.grid).to.deep.include({
        rows: 1,
        columns: 2
      });
      expect(
        result.documents[0].board.buttons.map(button => button.label)
      ).to.deep.equal(['喝水', '厕所']);
      if (fixture.format === 'touchchat') {
        expect(result.capabilities.touchChatCustomImages).to.equal(true);
        expect(result.documents[0].board.images).to.have.length(1);
        expect(result.documents[0].board.buttons[0].image_id).to.equal(
          'aac-image-1'
        );
      }
    });
  }
});

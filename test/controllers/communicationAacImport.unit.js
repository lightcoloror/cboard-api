'use strict';

const chai = require('chai');
const {
  CommunicationAacImportError,
  MAX_AAC_IMPORT_BYTES,
  MAX_AAC_IMPORT_BUTTONS,
  MAX_AAC_IMPORT_PAGES,
  convertCommunicationAacFile,
  createCommunicationAacImportService
} = require('../../api/helpers/communicationAacImport');
const {
  createCommunicationAacImportController,
  requestParameter
} = require('../../api/controllers/communicationAacImport');

const expect = chai.expect;
const SQLITE_SIGNATURE = Buffer.from('SQLite format 3\0', 'binary');
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function sourceBuffer(format, suffix = 'fixture') {
  return Buffer.concat([
    format === 'snap' ? SQLITE_SIGNATURE : ZIP_SIGNATURE,
    Buffer.from(suffix)
  ]);
}

function createTree() {
  const sharedImageButton = {
    id: 'drink',
    label: '喝水',
    message: '我想喝水',
    image: PNG_DATA_URL,
    style: { backgroundColor: '#aabbccff', borderColor: '#112233' },
    x: 1,
    y: 0
  };
  const nextButton = {
    id: 'next',
    label: '更多',
    message: '',
    semanticAction: { targetId: 'needs' },
    x: 0,
    y: 1
  };
  const repeatedImageButton = {
    id: 'repeat-drink',
    label: '再喝水',
    message: '再喝水',
    image: PNG_DATA_URL,
    x: 0,
    y: 0
  };
  return {
    rootId: 'home',
    pages: {
      needs: {
        id: 'needs',
        name: '需求',
        buttons: [repeatedImageButton],
        grid: [[repeatedImageButton]]
      },
      home: {
        id: 'home',
        name: '首页',
        locale: 'zh-CN',
        buttons: [sharedImageButton, nextButton],
        grid: [
          [null, sharedImageButton],
          [nextButton, null]
        ]
      }
    }
  };
}

function createLargeTree(pageCount = 348, buttonsPerPage = 35) {
  const pages = {};
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageId = `page-${pageIndex + 1}`;
    const buttons = Array.from(
      { length: buttonsPerPage },
      (_, buttonIndex) => ({
        id: `${pageId}-button-${buttonIndex + 1}`,
        label: `词语 ${pageIndex + 1}-${buttonIndex + 1}`,
        x: buttonIndex % 7,
        y: Math.floor(buttonIndex / 7)
      })
    );
    pages[pageId] = {
      id: pageId,
      name: `页面 ${pageIndex + 1}`,
      buttons
    };
  }
  return { rootId: 'page-1', pages };
}

function processorFor(tree, error) {
  return () => ({
    async loadIntoTree() {
      if (error) throw error;
      return tree;
    }
  });
}

function createResponse() {
  return {
    body: null,
    headers: {},
    statusCode: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    set(name, value) {
      if (typeof name === 'object') Object.assign(this.headers, name);
      else this.headers[name] = value;
      return this;
    }
  };
}

describe('Communication AAC import conversion', function() {
  it('converts pages to linked Open Board documents with per-board images', async function() {
    const result = await convertCommunicationAacFile(
      {
        buffer: sourceBuffer('snap'),
        fileName: '../patient.sps',
        format: 'snap',
        locale: 'zh-CN'
      },
      { createProcessor: processorFor(createTree()) }
    );

    expect(result).to.include({
      format: 'picinterpreter-aac-conversion',
      contractVersion: 1,
      sourceFormat: 'snap',
      sourceFileName: 'patient.sps'
    });
    expect(result.documents).to.have.length(2);
    expect(result.documents[0].board.id).to.equal('home');
    expect(result.documents[0].board.grid).to.deep.include({
      rows: 2,
      columns: 2
    });
    expect(result.documents[0].board.buttons[0]).to.include({
      label: '喝水',
      vocalization: '我想喝水',
      background_color: '#aabbcc',
      border_color: '#112233',
      image_id: 'aac-image-1'
    });
    expect(result.documents[0].board.buttons[1].load_board.path).to.equal(
      result.documents[1].path
    );
    expect(result.documents[0].board.images).to.have.length(1);
    expect(result.documents[1].board.images).to.have.length(1);
    expect(result.documents[1].board.buttons[0].image_id).to.equal(
      'aac-image-1'
    );
  });

  it('reports TouchChat custom-image support and keeps resolved images', async function() {
    const tree = createTree();
    tree.pages.home.buttons[0].image = undefined;
    const result = await convertCommunicationAacFile(
      {
        buffer: sourceBuffer('touchchat'),
        fileName: 'patient.ce',
        format: 'touchchat'
      },
      {
        createProcessor: processorFor(tree),
        resolveTouchChatImages(_buffer, parsedTree) {
          parsedTree.pages.home.buttons[0].image = PNG_DATA_URL;
          return {
            embeddedImageCount: 1,
            matchedButtonCount: 1,
            skippedImageCount: 0
          };
        }
      }
    );

    expect(result.capabilities).to.deep.equal({
      text: true,
      layout: true,
      embeddedRasterImages: true,
      touchChatCustomImages: true
    });
    expect(result.warnings).to.deep.equal([]);
    expect(result.documents[0].board.buttons[0]).to.include({
      image_id: 'aac-image-1'
    });
  });

  it('imports a bounded full vocabulary larger than the former 100-page limit', async function() {
    const tree = createLargeTree();
    const result = await convertCommunicationAacFile(
      {
        buffer: sourceBuffer('touchchat', 'large-vocabulary'),
        fileName: 'large-vocabulary.ce',
        format: 'touchchat'
      },
      {
        createProcessor: processorFor(tree),
        resolveTouchChatImages: () => ({
          embeddedImageCount: 0,
          matchedButtonCount: 0,
          skippedImageCount: 0
        })
      }
    );

    expect(result.documents).to.have.length(348);
    expect(
      result.documents.reduce(
        (total, document) => total + document.board.buttons.length,
        0
      )
    ).to.equal(12180);
    expect(MAX_AAC_IMPORT_PAGES).to.equal(500);
    expect(MAX_AAC_IMPORT_BUTTONS).to.equal(20000);
  });

  it('assigns stable unique ids when a source page reuses button identifiers', async function() {
    const tree = createTree();
    const duplicate = {
      id: 'drink',
      label: '再喝一次',
      x: 2,
      y: 0
    };
    tree.pages.home.buttons.push(duplicate);
    tree.pages.home.grid[0].push(duplicate);

    const result = await convertCommunicationAacFile(
      {
        buffer: sourceBuffer('snap', 'duplicate-button'),
        fileName: 'duplicate-button.sps',
        format: 'snap'
      },
      { createProcessor: processorFor(tree) }
    );
    const home = result.documents[0].board;

    expect(home.buttons.map(button => button.id)).to.deep.equal([
      'drink',
      'next',
      'drink--2'
    ]);
    expect(home.grid.order[0]).to.deep.equal([null, 'drink', 'drink--2']);
  });

  it('keeps large-vocabulary limits finite', async function() {
    for (const tree of [
      createLargeTree(MAX_AAC_IMPORT_PAGES + 1, 0),
      createLargeTree(1, MAX_AAC_IMPORT_BUTTONS + 1)
    ]) {
      let caught;
      try {
        await convertCommunicationAacFile(
          {
            buffer: sourceBuffer('snap', 'over-limit'),
            fileName: 'over-limit.sps',
            format: 'snap'
          },
          { createProcessor: processorFor(tree) }
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).to.be.instanceOf(CommunicationAacImportError);
    }
  });

  it('rejects unsupported formats, invalid signatures, and oversized input', async function() {
    for (const input of [
      { buffer: sourceBuffer('snap'), format: 'gridset' },
      { buffer: Buffer.from('not sqlite'), format: 'snap' },
      { buffer: Buffer.alloc(MAX_AAC_IMPORT_BYTES + 1), format: 'snap' }
    ]) {
      let caught;
      try {
        await convertCommunicationAacFile(input, {
          createProcessor: processorFor(createTree())
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).to.be.instanceOf(CommunicationAacImportError);
      expect(caught.statusCode).to.equal(400);
    }
  });

  it('maps parser failures to a stable 422 error without leaking internals', async function() {
    let caught;
    try {
      await convertCommunicationAacFile(
        { buffer: sourceBuffer('snap'), format: 'snap' },
        { createProcessor: processorFor(null, new Error('database details')) }
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(CommunicationAacImportError);
    expect(caught).to.include({
      statusCode: 422,
      code: 'AAC_IMPORT_PARSE_FAILED'
    });
    expect(caught.message).not.to.match(/database details/);
  });

  it('bounds concurrent native conversions and releases capacity afterward', async function() {
    let release;
    const pending = new Promise(resolve => {
      release = resolve;
    });
    const service = createCommunicationAacImportService({
      maxConcurrent: 1,
      converter: async input => {
        await pending;
        return input;
      }
    });
    const first = service({ id: 1 });

    let caught;
    try {
      await service({ id: 2 });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.include({ statusCode: 429, code: 'AAC_IMPORT_BUSY' });

    release();
    expect(await first).to.deep.equal({ id: 1 });
  });
});

describe('Communication AAC import controller', function() {
  it('reads Swagger parameters and returns a private non-cached response', async function() {
    let received;
    const controller = createCommunicationAacImportController({
      convert: async input => {
        received = input;
        return { documents: [] };
      }
    });
    const response = createResponse();
    const file = {
      buffer: sourceBuffer('snap'),
      originalname: 'patient.sps'
    };
    const request = {
      user: { id: 'user-1' },
      files: { file: [file] },
      query: { format: 'wrong' },
      swagger: {
        params: {
          format: { value: 'snap' },
          locale: { value: 'zh-CN' }
        }
      }
    };

    await controller.convertCommunicationAacFile(request, response);

    expect(response.statusCode).to.equal(200);
    expect(response.headers['Cache-Control']).to.equal('private, no-store');
    expect(received).to.deep.equal({
      buffer: file.buffer,
      fileName: 'patient.sps',
      format: 'snap',
      locale: 'zh-CN'
    });
    expect(requestParameter(request, 'format')).to.equal('snap');
  });

  it('rejects anonymous and missing-file requests before conversion', async function() {
    let calls = 0;
    const controller = createCommunicationAacImportController({
      convert: async () => {
        calls += 1;
      }
    });
    const anonymous = createResponse();
    const missing = createResponse();

    await controller.convertCommunicationAacFile({}, anonymous);
    await controller.convertCommunicationAacFile(
      { user: { id: 'user-1' } },
      missing
    );

    expect(anonymous.statusCode).to.equal(400);
    expect(missing.statusCode).to.equal(400);
    expect(calls).to.equal(0);
  });

  it('returns typed import errors and retry guidance', async function() {
    const controller = createCommunicationAacImportController({
      convert: async () => {
        throw new CommunicationAacImportError('busy', 429, 'AAC_IMPORT_BUSY');
      }
    });
    const response = createResponse();

    await controller.convertCommunicationAacFile(
      {
        user: { id: 'user-1' },
        files: {
          file: [{ buffer: sourceBuffer('snap'), originalname: 'file.sps' }]
        },
        query: { format: 'snap' }
      },
      response
    );

    expect(response.statusCode).to.equal(429);
    expect(response.headers['Retry-After']).to.equal('5');
    expect(response.body.error).to.deep.equal({
      code: 'AAC_IMPORT_BUSY',
      message: 'busy'
    });
  });
});

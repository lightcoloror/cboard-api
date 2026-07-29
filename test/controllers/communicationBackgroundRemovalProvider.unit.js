'use strict';

const chai = require('chai');
const {
  MAX_BACKGROUND_REMOVAL_OUTPUT_BYTES,
  createCommunicationBackgroundRemovalProvider,
  resolveBackgroundRemovalConfiguration,
  validateTransparentPng
} = require('../../api/helpers/communicationBackgroundRemovalProvider');

const expect = chai.expect;

function createPngChunk(type, data) {
  const payload = Buffer.from(data || []);
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  payload.copy(chunk, 8);
  return chunk;
}

function createPng({ colorType = 6, width = 320, height = 240 } = {}) {
  const header = Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a
  ]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    header,
    createPngChunk('IHDR', ihdr),
    createPngChunk('IEND')
  ]);
}

function createImage() {
  return {
    buffer: Buffer.from('caregiver-photo'),
    mimetype: 'image/jpeg'
  };
}

describe('Communication background removal provider', function () {
  it('stays disabled until a supported provider is configured', function () {
    expect(resolveBackgroundRemovalConfiguration({})).to.equal(null);
    expect(
      resolveBackgroundRemovalConfiguration({
        BACKGROUND_REMOVAL_PROVIDER: 'removebg'
      })
    ).to.equal(null);
  });

  it('uses a self-hosted rembg multipart contract without an API key', async function () {
    let requestOptions;
    const provider = createCommunicationBackgroundRemovalProvider({
      configuration: {
        provider: 'rembg',
        endpoint: 'http://127.0.0.1:7000/api/remove',
        apiKey: '',
        timeoutMs: 15000
      },
      boundaryFactory: () => 'test-boundary',
      request: async options => {
        requestOptions = options;
        return { data: createPng() };
      }
    });

    const result = await provider.removeBackground(createImage());

    expect(requestOptions.headers).not.to.have.property('X-Api-Key');
    expect(requestOptions.data.toString()).to.contain('name="file"');
    expect(result).to.include({
      mimeType: 'image/png',
      width: 320,
      height: 240,
      provider: 'rembg',
      sourceStored: false,
      originalRetained: true
    });
  });

  it('uses the remove.bg field name and keeps the key in the server request', async function () {
    let requestOptions;
    const provider = createCommunicationBackgroundRemovalProvider({
      configuration: {
        provider: 'removebg',
        endpoint: 'https://api.remove.bg/v1.0/removebg',
        apiKey: 'server-secret',
        timeoutMs: 30000
      },
      boundaryFactory: () => 'test-boundary',
      request: async options => {
        requestOptions = options;
        return { data: createPng({ width: 512, height: 512 }) };
      }
    });

    await provider.removeBackground(createImage());

    expect(requestOptions.headers['X-Api-Key']).to.equal(
      'server-secret'
    );
    expect(requestOptions.data.toString()).to.contain(
      'name="image_file"'
    );
    expect(requestOptions.data.toString()).to.contain(
      'name="format"'
    );
  });

  it('rejects a provider image without a transparent channel', function () {
    expect(() =>
      validateTransparentPng(createPng({ colorType: 2 }))
    ).to.throw('Background removal output has no transparency');
  });

  it('rejects unsupported input before contacting the provider', async function () {
    let called = false;
    const provider = createCommunicationBackgroundRemovalProvider({
      configuration: {
        provider: 'rembg',
        endpoint: 'http://127.0.0.1:7000/api/remove',
        apiKey: '',
        timeoutMs: 30000
      },
      request: async () => {
        called = true;
        return { data: createPng() };
      }
    });

    let error;
    try {
      await provider.removeBackground({
        buffer: Buffer.from('not-an-image'),
        mimetype: 'image/gif'
      });
    } catch (caught) {
      error = caught;
    }

    expect(called).to.equal(false);
    expect(error.status).to.equal(415);
  });

  it('rejects an oversized provider response', function () {
    expect(() =>
      validateTransparentPng(
        Buffer.alloc(MAX_BACKGROUND_REMOVAL_OUTPUT_BYTES + 1)
      )
    ).to.throw('empty or exceeds 4 MiB');
  });
});

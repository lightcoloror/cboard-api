'use strict';

const chai = require('chai');
const {
  createPublicBoardImageLoader,
  getAllowedPublicBoardImageHosts,
  loadPublicBoardTileImage,
  validatePublicBoardImageUrl
} = require('../../api/helpers/publicBoardImage');

const expect = chai.expect;

function publicBoard(image) {
  return {
    id: '507f1f77bcf86cd799439011',
    isPublic: true,
    tiles: [{ id: 'water', image }]
  };
}

describe('Public board image proxy', function() {
  it('accepts only configured HTTPS image hosts', function() {
    const hosts = getAllowedPublicBoardImageHosts({
      blobHost: 'https://blob.example.test',
      cdnHost: 'https://cdn.example.test'
    });

    expect(
      validatePublicBoardImageUrl(
        'https://cdn.example.test/boards/water.png',
        hosts
      ).href
    ).to.equal('https://cdn.example.test/boards/water.png');
    expect(
      validatePublicBoardImageUrl('http://cdn.example.test/water.png', hosts)
    ).to.equal(null);
    expect(
      validatePublicBoardImageUrl('https://127.0.0.1/water.png', hosts)
    ).to.equal(null);
  });

  it('loads and normalizes an allowlisted image without following redirects', async function() {
    const get = async (url, options) => {
      expect(url).to.equal('https://cdn.example.test/boards/water.png');
      expect(options).to.include({
        responseType: 'arraybuffer',
        maxRedirects: 0
      });
      return {
        headers: { 'content-type': 'image/jpeg' },
        data: Buffer.from([0xff, 0xd8, 0xff, 0x00])
      };
    };
    const result = await loadPublicBoardTileImage(
      null,
      '507f1f77bcf86cd799439011',
      'water',
      {
        allowedHosts: new Set(['cdn.example.test']),
        findPublicBoard: async () =>
          publicBoard('https://cdn.example.test/boards/water.png'),
        http: { get },
        normalizeImage: async buffer => ({
          buffer: Buffer.from(buffer),
          contentType: 'image/png'
        })
      }
    );

    expect(result.contentType).to.equal('image/png');
    expect(result.buffer).to.be.instanceOf(Buffer);
  });

  it('fails before network access for an untrusted tile image host', async function() {
    let requested = false;
    let caught;
    try {
      await loadPublicBoardTileImage(
        null,
        '507f1f77bcf86cd799439011',
        'water',
        {
          allowedHosts: new Set(['cdn.example.test']),
          findPublicBoard: async () =>
            publicBoard('https://private.example.test/secret.png'),
          http: {
            get: async () => {
              requested = true;
            }
          }
        }
      );
    } catch (error) {
      caught = error;
    }

    expect(requested).to.equal(false);
    expect(caught).to.include({
      statusCode: 422,
      code: 'PUBLIC_BOARD_IMAGE_HOST_NOT_ALLOWED'
    });
  });

  it('coalesces concurrent image normalization and reuses a bounded cache', async function() {
    let now = 1000;
    const get = async () => ({
      headers: { 'content-type': 'image/png' },
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47])
    });
    const http = {
      calls: 0,
      async get(...args) {
        this.calls += 1;
        return get(...args);
      }
    };
    const normalizeImage = async buffer => ({
      buffer: Buffer.from(buffer),
      contentType: 'image/png'
    });
    const loader = createPublicBoardImageLoader({
      allowedHosts: new Set(['cdn.example.test']),
      findPublicBoard: async () =>
        publicBoard('https://cdn.example.test/boards/water.png'),
      http,
      normalizeImage,
      now: () => now,
      cacheTtlMs: 50
    });

    const first = loader.loadPublicBoardTileImage(null, 'board', 'water');
    const second = loader.loadPublicBoardTileImage(null, 'board', 'water');
    const [firstImage, secondImage] = await Promise.all([first, second]);
    expect(firstImage).to.equal(secondImage);
    expect(http.calls).to.equal(1);

    await loader.loadPublicBoardTileImage(null, 'board', 'water');
    expect(http.calls).to.equal(1);
    now += 51;
    await loader.loadPublicBoardTileImage(null, 'board', 'water');
    expect(http.calls).to.equal(2);
  });
});

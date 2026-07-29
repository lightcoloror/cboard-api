'use strict';

const chai = require('chai');
const sharp = require('sharp');
const {
  MAX_PICTOGRAM_IMAGE_BYTES,
  isPngBuffer,
  normalizePublicPictogramImage
} = require('../../api/helpers/pictogramImage');

const expect = chai.expect;

describe('Pictogram image helper', function() {
  it('rasterizes SVG to a bounded PNG for mini-program clients', async function() {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><circle cx="60" cy="40" r="35" fill="#28a745"/></svg>'
    );

    const result = await normalizePublicPictogramImage(svg);
    const metadata = await sharp(result.buffer).metadata();

    expect(result.contentType).to.equal('image/png');
    expect(isPngBuffer(result.buffer)).to.equal(true);
    expect(metadata).to.include({ format: 'png', width: 300, height: 200 });
  });

  it('normalizes WebP input to PNG without exceeding 300 pixels', async function() {
    const webp = await sharp({
      create: {
        width: 600,
        height: 400,
        channels: 4,
        background: { r: 38, g: 132, b: 255, alpha: 1 }
      }
    })
      .webp()
      .toBuffer();

    const result = await normalizePublicPictogramImage(webp);
    const metadata = await sharp(result.buffer).metadata();

    expect(result.contentType).to.equal('image/png');
    expect(metadata).to.include({ format: 'png', width: 300, height: 200 });
  });

  it('rejects malformed image bytes', async function() {
    let error;
    try {
      await normalizePublicPictogramImage(Buffer.from('not-an-image'));
    } catch (caught) {
      error = caught;
    }

    expect(error).to.have.property('message', 'Invalid pictogram image');
  });

  it('rejects images whose declared dimensions exceed the pixel limit', async function() {
    const oversizedSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="10000"><rect width="10000" height="10000"/></svg>'
    );

    let error;
    try {
      await normalizePublicPictogramImage(oversizedSvg);
    } catch (caught) {
      error = caught;
    }

    expect(error).to.have.property('message', 'Invalid pictogram image');
  });

  it('rejects input larger than the download byte limit before decoding', async function() {
    let error;
    try {
      await normalizePublicPictogramImage(
        Buffer.alloc(MAX_PICTOGRAM_IMAGE_BYTES + 1)
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).to.have.property('message', 'Invalid pictogram image');
  });
});

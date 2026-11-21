'use strict';

const chai = require('chai');
const sharp = require('sharp');
const {
  MAX_PICTOGRAM_IMAGE_BYTES,
  isGif89aBuffer,
  isPngBuffer,
  normalizeAnimatedPictogramImage,
  normalizePublicPictogramImage
} = require('../../api/helpers/pictogramImage');

const expect = chai.expect;

async function createSyntheticGif({
  width = 300,
  height = 300,
  frames = 4,
  delay = [500, 450, 500, 950]
} = {}) {
  const palette = [
    { r: 255, g: 255, b: 255, alpha: 1 },
    { r: 254, g: 240, b: 138, alpha: 1 },
    { r: 191, g: 219, b: 254, alpha: 1 },
    { r: 187, g: 247, b: 208, alpha: 1 }
  ];
  const frameBufs = [];
  for (let i = 0; i < frames; i += 1) {
    const bg = palette[i % palette.length];
    const raw = await sharp({
      create: { width, height, channels: 4, background: bg }
    })
      .raw()
      .toBuffer();
    frameBufs.push(raw);
  }
  const strip = Buffer.concat(frameBufs);
  return sharp(strip, {
    raw: {
      width,
      height: height * frames,
      channels: 4,
      pageHeight: height
    }
  })
    .gif({
      colours: 16,
      delay: frames > 1 ? delay : undefined,
      loop: 2
    })
    .toBuffer();
}

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

  it('passes valid bounded GIF89a animated frames through unchanged when allowAnimatedGif is true', async function() {
    const gif = await createSyntheticGif({
      width: 300,
      height: 300,
      frames: 4,
      delay: [500, 450, 500, 950]
    });

    expect(isGif89aBuffer(gif)).to.equal(true);
    const result = await normalizeAnimatedPictogramImage(gif);
    expect(result.contentType).to.equal('image/gif');
    expect(result.animated).to.equal(true);
    expect(result.pages).to.equal(4);
    expect(result.width).to.equal(300);
    expect(result.height).to.equal(300);
    expect(Buffer.compare(result.buffer, gif)).to.equal(0);
  });

  it('flattens animated GIF to static PNG by default for backward compatibility', async function() {
    const gif = await createSyntheticGif({ frames: 4 });
    const result = await normalizePublicPictogramImage(gif);
    const meta = await sharp(result.buffer).metadata();

    expect(result.contentType).to.equal('image/png');
    expect(isPngBuffer(result.buffer)).to.equal(true);
    expect(meta.format).to.equal('png');
    expect(meta.pages || 1).to.equal(1);
  });

  it('normalizes single-frame static GIF89a to PNG even when allowAnimatedGif is true', async function() {
    const gif = await createSyntheticGif({ frames: 1 });
    const result = await normalizePublicPictogramImage(gif, {
      allowAnimatedGif: true
    });

    expect(result.contentType).to.equal('image/png');
    expect(isPngBuffer(result.buffer)).to.equal(true);
  });

  it('rejects animated GIF exceeding the 8-frame limit', async function() {
    const gif = await createSyntheticGif({
      frames: 9,
      delay: Array(9).fill(400)
    });

    let error;
    try {
      await normalizePublicPictogramImage(gif, { allowAnimatedGif: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.have.property(
      'message',
      'Invalid animated pictogram GIF: too_many_frames'
    );
  });

  it('rejects animated GIF exceeding 300x300 dimensions', async function() {
    const gif = await createSyntheticGif({
      width: 360,
      height: 360,
      frames: 2,
      delay: [500, 500]
    });

    let error;
    try {
      await normalizePublicPictogramImage(gif, { allowAnimatedGif: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.have.property(
      'message',
      'Invalid animated pictogram GIF: dimensions_exceeded'
    );
  });

  it('rejects photosensitive rapid strobe GIF below 250ms per frame', async function() {
    const gif = await createSyntheticGif({
      frames: 4,
      delay: [80, 80, 80, 80]
    });

    let error;
    try {
      await normalizePublicPictogramImage(gif, { allowAnimatedGif: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.have.property(
      'message',
      'Invalid animated pictogram GIF: frame_delay_too_fast'
    );
  });

  it('falls back to bounded static PNG when fallbackToStaticPng is true and GIF violates byte or frame limits', async function() {
    const tooLargeGif = await createSyntheticGif({
      width: 360,
      height: 360,
      frames: 9,
      delay: Array(9).fill(400)
    });
    const out = await normalizePublicPictogramImage(tooLargeGif, {
      allowAnimatedGif: true,
      fallbackToStaticPng: true
    });
    const meta = await sharp(out.buffer).metadata();
    expect(out.contentType).to.equal('image/png');
    expect(meta.width).to.be.at.most(300);
    expect(meta.height).to.be.at.most(300);

    // Genuine >128KB valid GIF89a via incompressible deterministic pixel noise
    const noisyFrames = [];
    for (let f = 0; f < 4; f += 1) {
      const px = Buffer.alloc(300 * 300 * 4);
      let s = (f + 1) * 1337;
      for (let i = 0; i < px.length; i += 4) {
        s = (s * 1664525 + 1013904223) >>> 0;
        px[i] = s & 0xff;
        px[i + 1] = (s >>> 8) & 0xff;
        px[i + 2] = (s >>> 16) & 0xff;
        px[i + 3] = 255;
      }
      noisyFrames.push(px);
    }
    const bigValidGif = await sharp(Buffer.concat(noisyFrames), {
      raw: { width: 300, height: 1200, channels: 4, pageHeight: 300 }
    })
      .gif({ colours: 256, delay: [400, 400, 400, 400], loop: 2 })
      .toBuffer();
    expect(bigValidGif.length).to.be.greaterThan(128 * 1024);

    let bigErr;
    try {
      await normalizePublicPictogramImage(bigValidGif, {
        allowAnimatedGif: true
      });
    } catch (caught) {
      bigErr = caught;
    }
    expect(bigErr).to.have.property(
      'message',
      'Invalid animated pictogram GIF: too_large_bytes'
    );

    const fallbackOverBytes = await normalizePublicPictogramImage(bigValidGif, {
      allowAnimatedGif: true,
      fallbackToStaticPng: true
    });
    expect(fallbackOverBytes.contentType).to.equal('image/png');
    expect(isPngBuffer(fallbackOverBytes.buffer)).to.equal(true);
  });
});

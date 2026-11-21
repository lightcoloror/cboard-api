'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { expect } = require('chai');

const {
  MAX_SVG_BYTES,
  assertSafeVectorSvg,
  createPictogramVectorizer,
  vectorizePngToCleanSvg
} = require('../../api/helpers/pictogramVectorizer');
const { composeMissingPictogram } = require('../../api/helpers/pictogramComposer');
const { finalizeRefinedStaticCard } = require('../../api/helpers/pictogramRegenPipeline');
const { isPngBuffer } = require('../../api/helpers/pictogramImage');

async function makeSyntheticContrastPng() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300">
    <rect width="300" height="300" fill="#FFFFFF"/>
    <rect x="65" y="95" width="170" height="110" rx="22" fill="#3B82F6" stroke="#1E1E1E" stroke-width="10"/>
    <circle cx="115" cy="150" r="24" fill="#FFFFFF" stroke="#1E1E1E" stroke-width="8"/>
    <circle cx="185" cy="150" r="24" fill="#FFFFFF" stroke="#1E1E1E" stroke-width="8"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe('Built-in and pluggable SVG vectorizer (Step 4)', function () {
  this.timeout(20000);

  it('vectorizes composed and reference PNGs into compact safe smooth-contour SVGs under 96KB', async function () {
    const composed = await composeMissingPictogram('眼镜盒', {
      format: 'png',
      includeLabel: false,
      includeNoLabelPng: true
    });
    const pngInput = composed.noLabelPngBuffer || composed.pngBuffer;
    const traced = await vectorizePngToCleanSvg(pngInput);

    expect(traced.engine).to.equal('builtin-smooth-contour');
    expect(traced.bytes).to.be.greaterThan(200);
    expect(traced.bytes).to.be.at.most(MAX_SVG_BYTES);
    expect(traced.svg).to.include('<svg');
    expect(traced.svg).to.include('</svg>');
    expect(traced.svg).to.include('fill-rule="evenodd"');
    expect(traced.colorCount).to.be.at.least(2);

    const renderedBack = await sharp(Buffer.from(traced.svg, 'utf8')).png().toBuffer();
    const meta = await sharp(renderedBack).metadata();
    expect(meta.width).to.equal(300);
    expect(meta.height).to.equal(300);

    const refPath = path.resolve(
      __dirname,
      '../../../../outputs/tuyujia-svg-gif-benchmark-20261121/schemeD_ref2img/眼镜盒_nolabel.png'
    );
    if (fs.existsSync(refPath)) {
      const refTraced = await vectorizePngToCleanSvg(fs.readFileSync(refPath));
      expect(refTraced.bytes).to.be.at.most(MAX_SVG_BYTES);
      expect(refTraced.colorCount).to.be.at.least(3);
    }
  });

  it('rejects XSS payloads, event handlers, foreignObject, external URLs, and oversized SVGs', function () {
    const unsafeSamples = [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(1)"><rect width="10" height="10"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect width="10" height="10"/></a></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>x</div></foreignObject></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/a.png"/></svg>',
      'not-even-svg'
    ];

    for (const sample of unsafeSamples) {
      let err;
      try {
        assertSafeVectorSvg(sample);
      } catch (caught) {
        err = caught;
      }
      expect(err, `Expected rejection for ${sample}`).to.be.an('error');
      expect([502]).to.include(err.status);
    }

    const huge = `<svg xmlns="http://www.w3.org/2000/svg"><path d="${'M0 0h1'.repeat(20000)}"/></svg>`;
    let sizeErr;
    try {
      assertSafeVectorSvg(huge);
    } catch (caught) {
      sizeErr = caught;
    }
    expect(sizeErr).to.include({ code: 'SVG_BYTE_BUDGET_EXCEEDED', status: 502 });
  });

  it('integrates directly with Step 3 finalizeRefinedStaticCard vectorizer hook', async function () {
    const syntheticPng = await makeSyntheticContrastPng();
    const vectorizer = createPictogramVectorizer({ gridSize: 96, maxColors: 8 });
    const card = await finalizeRefinedStaticCard(syntheticPng, '眼镜盒', { vectorizer });

    expect(isPngBuffer(card.noLabelPngBuffer)).to.equal(true);
    expect(isPngBuffer(card.cardPngBuffer)).to.equal(true);
    expect(card.svg).to.be.a('string').and.to.include('<svg');
    expect(Buffer.byteLength(card.svg, 'utf8')).to.be.at.most(MAX_SVG_BYTES);
  });

  it('uses optional @neplex/vectorizer hook when injected and still enforces SVG safety validation', async function () {
    const syntheticPng = await makeSyntheticContrastPng();
    let seenConfig = null;
    const mockNeplex = {
      async vectorize(buf, config) {
        seenConfig = config;
        expect(Buffer.isBuffer(buf)).to.equal(true);
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="#FFFFFF"/><circle cx="150" cy="150" r="60" fill="#2563EB"/></svg>';
      }
    };

    const ok = await vectorizePngToCleanSvg(syntheticPng, { neplexModule: mockNeplex });
    expect(ok.engine).to.equal('neplex-vtracer');
    expect(ok.svg).to.include('<circle cx="150"');
    expect(seenConfig).to.include({ mode: 2, colorMode: 0 });

    const maliciousNeplex = {
      async vectorize() {
        return '<svg xmlns="http://www.w3.org/2000/svg"><script>steal()</script></svg>';
      }
    };
    let caughtErr;
    try {
      await vectorizePngToCleanSvg(syntheticPng, { neplexModule: maliciousNeplex });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).to.include({ code: 'UNSAFE_VECTORIZED_SVG', status: 502 });
  });
});

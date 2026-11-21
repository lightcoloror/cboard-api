'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const request = require('supertest');
const sharp = require('sharp');
const { expect } = require('chai');

const pictogramController = require('../../api/controllers/pictogram');
const {
  composeMissingPictogram,
  escapeXml,
  planSymbolComposition,
  renderRecipeToSvg,
  sanitizeCompositionLabel
} = require('../../api/helpers/pictogramComposer');
const {
  isGif89aBuffer,
  isPngBuffer,
  normalizeAnimatedPictogramImage
} = require('../../api/helpers/pictogramImage');

describe('Pictogram deterministic composer (Step 2)', function () {
  this.timeout(25000);

  it('composes all 7 curated 2026-11-13 missing AAC words into valid SVG, 300px PNG, and <60KB 4-frame GIF89a', async function () {
    const cases = [
      { label: '助听器电池', op: 'focus_part_of', mode: 'compose', regen: false },
      { label: '轮椅坐垫', op: 'locate_on', mode: 'compose', regen: false },
      { label: '眼镜盒', op: 'container_put', mode: 'compose', regen: false },
      { label: '充电宝', op: 'link_flow', mode: 'compose', regen: false },
      { label: '折叠拐杖', op: 'modify_attr', mode: 'compose', regen: false },
      { label: '打伞', op: 'act_with', mode: 'compose', regen: false },
      { label: '血糖试纸', op: 'modify_attr', mode: 'regen_from_ref', regen: true }
    ];

    for (const c of cases) {
      const out = await composeMissingPictogram(c.label, {
        format: 'all',
        includeNoLabelPng: true
      });

      expect(out.recipe.op).to.equal(c.op);
      expect(out.recipe.mode).to.equal(c.mode);
      expect(out.recipe.needsRegenFallback).to.equal(c.regen);
      expect(out.recipe.license).to.equal('CC BY-SA 2.0');

      const usedFiles = out.recipe.sourceParts.map(p => p.file);
      expect(usedFiles).to.not.include('box_,_to.svg');
      expect(usedFiles).to.not.include('stick.svg');

      expect(out.svg).to.include('<svg').and.include(c.label);
      expect(out.svg.toLowerCase()).to.not.include('<script');

      const pngMeta = await sharp(out.pngBuffer).metadata();
      expect(pngMeta).to.include({ format: 'png', width: 300, height: 300 });
      expect(isPngBuffer(out.noLabelPngBuffer)).to.equal(true);

      expect(isGif89aBuffer(out.gifBuffer)).to.equal(true);
      expect(out.gifBuffer.length).to.be.lessThan(60 * 1024);

      const gated = await normalizeAnimatedPictogramImage(out.gifBuffer);
      expect(gated.contentType).to.equal('image/gif');
      expect(gated.pages).to.equal(4);

      const gifMeta = await sharp(out.gifBuffer, { animated: true }).metadata();
      expect(gifMeta.pages).to.equal(4);
      expect(gifMeta.width).to.equal(300);
      expect(Number(gifMeta.pageHeight || gifMeta.height)).to.equal(300);
      expect(gifMeta.delay[0]).to.be.at.least(250);
    }
  });

  it('handles 6 generalized ambiguous multi-morpheme patterns cleanly', async function () {
    for (const phrase of ['不想吃药', '不想喝水', '不吃饭']) {
      const out = await composeMissingPictogram(phrase, { format: 'gif' });
      expect(out.recipe.op).to.equal('negate_thought');
      expect(out.svg).to.include('#E11D48');
      expect(out.svg).to.include('stroke-dasharray');
      expect(isGif89aBuffer(out.gifBuffer)).to.equal(true);
      expect(out.gifBuffer.length).to.be.lessThan(60 * 1024);
    }

    const seqCases = [
      { phrase: '先吃饭再吃药', expectA: 'rice', expectB: 'tablets' },
      { phrase: '先洗手再吃饭', expectA: 'wash_hands_to', expectB: 'rice' }
    ];
    for (const s of seqCases) {
      const out = await composeMissingPictogram(s.phrase, { format: 'gif' });
      expect(out.recipe.op).to.equal('sequence_ab');
      expect(out.recipe.context).to.equal(s.expectA);
      expect(out.recipe.head).to.equal(s.expectB);
      expect(out.svg).to.include('>1<').and.include('>2<');
      expect(isGif89aBuffer(out.gifBuffer)).to.equal(true);
    }

    for (const boxWord of ['眼镜盒', '药盒']) {
      const recipe = planSymbolComposition(boxWord);
      expect(recipe.op).to.equal('container_put');
      expect(recipe.sourceParts.map(p => p.file)).to.not.include('box_,_to.svg');

      const animFrame0 = renderRecipeToSvg(recipe, { frameIdx: 0 });
      const staticFrame3 = renderRecipeToSvg(recipe, { frameIdx: 3 });
      expect(animFrame0).to.include('url(#blueArrow)');
      expect(staticFrame3).to.not.include('url(#blueArrow)');
    }
  });

  it('escapes XML metacharacters and blocks script injection in labels', async function () {
    const rawAttack = '<script>alert("1")</script>';
    const clean = sanitizeCompositionLabel(rawAttack);
    expect(clean.length).to.be.at.most(24);
    expect(escapeXml('a & <b > "c"')).to.equal('a &amp; &lt;b &gt; &quot;c&quot;');

    const out = await composeMissingPictogram('<img & "x">', { format: 'svg' });
    expect(out.svg.toLowerCase()).to.not.include('<img');
    expect(out.svg.toLowerCase()).to.not.include('<script');
    expect(out.svg).to.include('&lt;img &amp; &quot;x&quot;&gt;');
  });

  it('exposes composePictogram Express controller with strict validation and CC BY-SA metadata', async function () {
    const app = express();
    app.use(bodyParser.json());
    app.post('/pictograms/compose', pictogramController.composePictogram);

    const okRes = await request(app)
      .post('/pictograms/compose')
      .send({ label: '助听器电池', format: 'gif' })
      .expect(200);

    expect(okRes.body).to.include({
      label: '助听器电池',
      mode: 'compose',
      op: 'focus_part_of',
      mediaType: 'gif',
      mimeType: 'image/gif',
      license: 'CC BY-SA 2.0',
      needsRegenFallback: false
    });
    expect(okRes.body.attribution).to.include('Mulberry');
    expect(okRes.body.sourceParts).to.be.an('array').with.length.at.least(2);
    const decoded = Buffer.from(okRes.body.imageBase64, 'base64');
    expect(isGif89aBuffer(decoded)).to.equal(true);
    expect(decoded.length).to.be.lessThan(60 * 1024);

    await request(app).post('/pictograms/compose').send({ label: '   ' }).expect(400);
    await request(app)
      .post('/pictograms/compose')
      .send({ label: '超过二十四个字的超级长沟通卡片测试字符串肯定会超出限制' })
      .expect(400);
    await request(app)
      .post('/pictograms/compose')
      .send({ label: '打伞', format: 'webp' })
      .expect(400);
  });
});

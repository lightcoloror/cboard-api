'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const request = require('supertest');
const sharp = require('sharp');
const { expect } = require('chai');

const {
  anonymizePersonReferenceLabel,
  assertNoPersonalIdentityLeak,
  createConfirmedPictogramCache,
  createPictogramPipelineController,
  createTwoTierPictogramPipeline,
  finalizeRefinedStaticCard,
  sliceTwoPanelSpriteToGif
} = require('../../api/helpers/pictogramRegenPipeline');
const {
  isGif89aBuffer,
  isPngBuffer,
  normalizeAnimatedPictogramImage
} = require('../../api/helpers/pictogramImage');

async function makeSyntheticWideSpritePng() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 512" width="1024" height="512">
    <rect width="1024" height="512" fill="#FFFFFF"/>
    <circle cx="256" cy="256" r="110" fill="#FDE047" stroke="#231F20" stroke-width="18"/>
    <rect x="650" y="140" width="220" height="220" rx="28" fill="#60A5FA" stroke="#231F20" stroke-width="18"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function makeSyntheticSquarePng() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <rect width="512" height="512" fill="#FFFFFF"/>
    <rect x="120" y="210" width="272" height="90" rx="16" fill="#FFFFFF" stroke="#231F20" stroke-width="18"/>
    <circle cx="170" cy="175" r="24" fill="#DC2626" stroke="#231F20" stroke-width="12"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe('Pictogram two-tier regeneration pipeline & SQLite cache flywheel (Step 3)', function () {
  this.timeout(25000);

  it('enforces personal photo upload block (403) and anonymizes registered person names', function () {
    let privacyErr;
    try {
      assertNoPersonalIdentityLeak({ containsPersonalPhoto: true });
    } catch (caught) {
      privacyErr = caught;
    }
    expect(privacyErr).to.include({ status: 403, code: 'PRIVACY_PERSONAL_PHOTO_BLOCKED' });

    const anon = anonymizePersonReferenceLabel('给妈妈和张阿姨倒水', ['张', '妈妈', '张阿姨']);
    expect(anon.sanitizedLabel).to.equal('给PERSON_2和PERSON_1倒水');
    expect(anon.replacements).to.have.lengthOf(2);
  });

  it('slices a 2-panel horizontal sprite into a valid 2-frame GIF89a and extracts a label-free PNG', async function () {
    const spritePng = await makeSyntheticWideSpritePng();
    const sliced = await sliceTwoPanelSpriteToGif(spritePng, { label: '眼镜盒' });

    expect(isPngBuffer(sliced.noLabelPngBuffer)).to.equal(true);
    expect(isPngBuffer(sliced.cardPngBuffer)).to.equal(true);
    expect(isGif89aBuffer(sliced.gifBuffer)).to.equal(true);

    const gated = await normalizeAnimatedPictogramImage(sliced.gifBuffer);
    expect(gated.contentType).to.equal('image/gif');
    expect(gated.pages).to.equal(2);
    expect(gated.width).to.equal(300);
    expect(gated.height).to.equal(300);

    const meta = await sharp(sliced.gifBuffer, { animated: true }).metadata();
    expect(meta.delay[0]).to.be.at.least(250);
  });

  it('finalizes static refined cards with optional vectorizer and rejects unsafe <script> SVGs', async function () {
    const squarePng = await makeSyntheticSquarePng();
    const okOut = await finalizeRefinedStaticCard(squarePng, '血糖试纸', {
      vectorizer: async () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><circle cx="150" cy="150" r="60"/></svg>'
    });
    expect(isPngBuffer(okOut.noLabelPngBuffer)).to.equal(true);
    expect(isPngBuffer(okOut.cardPngBuffer)).to.equal(true);
    expect(okOut.svg).to.include('<svg');

    let badSvgErr;
    try {
      await finalizeRefinedStaticCard(squarePng, '血糖试纸', {
        vectorizer: async () => '<svg><script>alert(1)</script></svg>'
      });
    } catch (caught) {
      badSvgErr = caught;
    }
    expect(badSvgErr).to.include({ status: 502, code: 'INVALID_VECTORIZED_SVG' });
  });

  it('isolates SQLite confirmed cache entries by scopeId, tracks hitCount, and rejects unvalidated blobs', async function () {
    const cache = createConfirmedPictogramCache({ dbPath: ':memory:' });
    try {
      const cardPng = await makeSyntheticSquarePng();
      const saved = await cache.saveConfirmed('family-a', {
        label: '血糖试纸',
        mimeType: 'image/png',
        imageBuffer: cardPng,
        tier: 'tier2_regenerated',
        iconicity: { passed: true, tier: 'transparent' }
      });
      expect(saved.saved).to.equal(true);
      expect(saved.mimeType).to.equal('image/png');

      // Different tenant cannot see family-a card
      expect(cache.getConfirmed('family-b', '血糖试纸')).to.equal(null);

      const hit1 = cache.getConfirmed('family-a', '血糖试纸');
      expect(hit1.cacheHit).to.equal(true);
      expect(hit1.hitCount).to.equal(1);

      const hit2 = cache.getConfirmed('family-a', '血糖试纸');
      expect(hit2.hitCount).to.equal(2);
      expect(cache.listScope('family-a')).to.have.lengthOf(1);

      let invalidErr;
      try {
        await cache.saveConfirmed('family-a', {
          label: '坏图',
          mimeType: 'image/png',
          imageBuffer: Buffer.from('corrupt-bytes')
        });
      } catch (caught) {
        invalidErr = caught;
      }
      expect(invalidErr).to.be.an('error');
    } finally {
      cache.close();
    }
  });

  it('orchestrates Tier-1, Tier-2 + Blind Gate + Cache Hit, and Circuit Breaker end-to-end', async function () {
    const squarePng = await makeSyntheticSquarePng();
    const editCalls = [];
    const vlmCalls = [];
    let mockVlmAnswer = '测血糖, 血糖试纸';

    const cache = createConfirmedPictogramCache({ dbPath: ':memory:' });
    const pipeline = createTwoTierPictogramPipeline({
      cache,
      imageEditClient: {
        editFromReference: async (req) => {
          editCalls.push(req);
          return {
            rawImageBuffer: squarePng,
            usage: { total_tokens: 42 }
          };
        }
      },
      vlmClient: {
        chat: {
          completions: {
            create: async (body) => {
              vlmCalls.push(body);
              return {
                choices: [{ message: { content: mockVlmAnswer } }],
                usage: { total_tokens: 15 }
              };
            }
          }
        }
      },
      vectorizer: async () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="#fff"/></svg>'
    });

    try {
      // (a) Default Tier-1 handles 轮椅坐垫 with 0 imageEdit calls
      const tier1Out = await pipeline.resolveMissingPictogram({
        label: '轮椅坐垫',
        scopeId: 'family-1'
      });
      expect(tier1Out.status).to.equal('ready');
      expect(tier1Out.tier).to.equal('tier1_composed');
      expect(tier1Out.canUpgradeToTier2).to.equal(true);
      expect(editCalls).to.have.lengthOf(0);

      // (b) 血糖试纸 auto-routes to Stage 2 + Stage 3 -> Caregiver Confirm -> Stage 0 Cache Hit
      const tier2Out = await pipeline.resolveMissingPictogram({
        label: '血糖试纸',
        scopeId: 'family-1'
      });
      expect(tier2Out.status).to.equal('ready_for_caregiver_confirm');
      expect(tier2Out.tier).to.equal('tier2_regenerated');
      expect(tier2Out.gate.passed).to.equal(true);
      expect(tier2Out.gate.tier).to.equal('transparent');
      expect(tier2Out.svg).to.include('<svg');
      expect(editCalls).to.have.lengthOf(1);
      expect(vlmCalls).to.have.lengthOf(1);

      await pipeline.confirmAndCache({
        scopeId: 'family-1',
        label: tier2Out.label,
        mimeType: tier2Out.mimeType,
        imageBuffer: tier2Out.imageBuffer,
        svg: tier2Out.svg,
        tier: tier2Out.tier,
        recipe: tier2Out.recipe,
        iconicity: tier2Out.gate
      });

      const cachedOut = await pipeline.resolveMissingPictogram({
        label: '血糖试纸',
        scopeId: 'family-1'
      });
      expect(cachedOut.status).to.equal('cache_hit');
      expect(cachedOut.cacheHit).to.equal(true);
      expect(editCalls).to.have.lengthOf(1); // Zero extra image edits on 2nd request!

      // (c) Negation swallowing triggers Stage 3 Circuit Breaker and cannot be cached
      mockVlmAnswer = '吃药, 药瓶';
      const brokenOut = await pipeline.resolveMissingPictogram({
        label: '不想吃药',
        scopeId: 'family-1',
        forceRefinement: true
      });
      expect(brokenOut.status).to.equal('circuit_broken');
      expect(brokenOut.circuitBroken).to.equal(true);
      expect(brokenOut.blockedImageNotReturned).to.equal(true);
      expect(brokenOut.gate.reason).to.equal('negation_swallowed');

      let cacheRejectErr;
      try {
        await pipeline.confirmAndCache({
          scopeId: 'family-1',
          label: '不想吃药',
          mimeType: 'image/png',
          imageBuffer: squarePng,
          iconicity: brokenOut.gate
        });
      } catch (caught) {
        cacheRejectErr = caught;
      }
      expect(cacheRejectErr).to.include({ status: 422, code: 'ICONICITY_GATE_REJECTED' });
    } finally {
      cache.close();
    }
  });

  it('serves Express resolvePictogram & confirmPictogram HTTP routes with privacy and cache flywheel', async function () {
    const spritePng = await makeSyntheticWideSpritePng();
    const cache = createConfirmedPictogramCache({ dbPath: ':memory:' });
    const pipeline = createTwoTierPictogramPipeline({
      cache,
      imageEditClient: {
        editFromReference: async () => ({
          rawImageBuffer: spritePng,
          usage: { total_tokens: 30 }
        })
      },
      vlmClient: {
        chat: {
          completions: {
            create: async () => ({
              choices: [{ message: { content: '打伞, 下雨' } }]
            })
          }
        }
      }
    });

    const controller = createPictogramPipelineController({ pipeline });
    const app = express();
    app.use(bodyParser.json({ limit: '5mb' }));
    app.post('/pictograms/resolve', controller.resolvePictogram);
    app.post('/pictograms/confirm', controller.confirmPictogram);

    try {
      // Personal photo refused with 403
      const privRes = await request(app)
        .post('/pictograms/resolve')
        .send({ label: '打伞', forceRefinement: true, containsPersonalPhoto: true })
        .expect(403);
      expect(privRes.body.error.code).to.equal('PRIVACY_PERSONAL_PHOTO_BLOCKED');

      // Stage 2 animated sprite slicing + VLM pass
      const resolveRes = await request(app)
        .post('/pictograms/resolve')
        .send({ label: '打伞', scopeId: 'family-http', forceRefinement: true })
        .expect(200);
      expect(resolveRes.body.status).to.equal('ready_for_caregiver_confirm');
      expect(resolveRes.body.mimeType).to.equal('image/gif');
      expect(isGif89aBuffer(Buffer.from(resolveRes.body.imageBase64, 'base64'))).to.equal(true);

      // Confirm & cache
      const confirmRes = await request(app)
        .post('/pictograms/confirm')
        .send({
          scopeId: 'family-http',
          label: '打伞',
          mimeType: resolveRes.body.mimeType,
          imageBase64: resolveRes.body.imageBase64,
          iconicity: resolveRes.body.gate
        })
        .expect(200);
      expect(confirmRes.body.saved).to.equal(true);

      // Next request hits SQLite cache immediately
      const secondRes = await request(app)
        .post('/pictograms/resolve')
        .send({ label: '打伞', scopeId: 'family-http' })
        .expect(200);
      expect(secondRes.body.cacheHit).to.equal(true);
      expect(secondRes.body.hitCount).to.equal(1);
    } finally {
      cache.close();
    }
  });
});

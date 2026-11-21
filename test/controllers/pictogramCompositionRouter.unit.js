'use strict';

const express = require('express');
const request = require('supertest');
const sharp = require('sharp');
const { expect } = require('chai');

const {
  createDefaultPictogramCompositionRuntime
} = require('../../api/helpers/pictogramCompositionRuntime');
const {
  createPictogramCompositionRouter,
  deriveUserScopeId
} = require('../../api/helpers/pictogramCompositionRouter');
const { createPictogramVectorizer } = require('../../api/helpers/pictogramVectorizer');
const { isGif89aBuffer } = require('../../api/helpers/pictogramImage');
const { createWorkbenchApp } = require('../../scripts/servePictogramWorkbench.cjs');

async function makeWideSpritePng() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 512" width="1024" height="512">
    <rect width="1024" height="512" fill="#FFFFFF"/>
    <circle cx="256" cy="256" r="105" fill="#FDE047" stroke="#231F20" stroke-width="18"/>
    <rect x="640" y="150" width="240" height="210" rx="28" fill="#60A5FA" stroke="#231F20" stroke-width="18"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function makeAuthMiddleware() {
  return async (req, header) => {
    if (header === 'Bearer token-user-a') {
      req.user = { id: 'user-a-001' };
      return true;
    }
    if (header === 'Bearer token-user-b') {
      req.user = { id: 'user-b-002' };
      return true;
    }
    return false;
  };
}

describe('Pictogram Composition V2 Router & Workbench (Step 4)', function () {
  this.timeout(25000);

  let runtime;
  let app;

  function mountRouter(overrides = {}) {
    const mounted = express();
    mounted.use(
      '/pictograms/v2',
      createPictogramCompositionRouter({
        pipeline: runtime.pipeline,
        cache: runtime.cache,
        enabled: true,
        authenticate: makeAuthMiddleware(),
        requireAuth: true,
        allowedOrigins: ['https://app.tuyujia.com.cn'],
        isTier2Configured: runtime.isTier2Configured,
        ...overrides
      })
    );
    return mounted;
  }

  beforeEach(function () {
    runtime = createDefaultPictogramCompositionRuntime({
      cacheDbPath: ':memory:',
      vectorizer: createPictogramVectorizer()
    });
    app = mountRouter();
  });

  afterEach(function () {
    if (runtime) {
      runtime.close();
      runtime = null;
    }
  });

  it('enforces feature flag disabled gate (503) and CORS origin whitelist (403)', async function () {
    const disabledApp = mountRouter({ enabled: false });
    const resDisabled = await request(disabledApp).get('/pictograms/v2/health');
    expect(resDisabled.status).to.equal(503);
    expect(resDisabled.body.error.code).to.equal('PICTOGRAM_COMPOSITION_NOT_ENABLED');

    const resCors = await request(app)
      .get('/pictograms/v2/health')
      .set('Origin', 'https://evil.example');
    expect(resCors.status).to.equal(403);
    expect(resCors.body.error.code).to.equal('ORIGIN_NOT_ALLOWED');

    const resPreflight = await request(app)
      .options('/pictograms/v2/resolve')
      .set('Origin', 'https://app.tuyujia.com.cn');
    expect(resPreflight.status).to.equal(204);
    expect(resPreflight.headers['access-control-allow-origin']).to.equal('https://app.tuyujia.com.cn');
  });

  it('requires valid Bearer authentication (401) and enforces rate limiter (429 + Retry-After)', async function () {
    const unauth = await request(app)
      .post('/pictograms/v2/compose')
      .send({ label: '打伞' });
    expect(unauth.status).to.equal(401);
    expect(unauth.body.error.code).to.equal('LOGIN_REQUIRED');

    const badToken = await request(app)
      .post('/pictograms/v2/compose')
      .set('Authorization', 'Bearer wrong')
      .send({ label: '打伞' });
    expect(badToken.status).to.equal(401);

    const limitedApp = mountRouter({
      limiter: {
        async consume() {
          throw { msBeforeNext: 4200 };
        }
      }
    });
    const resLimited = await request(limitedApp)
      .post('/pictograms/v2/compose')
      .set('Authorization', 'Bearer token-user-a')
      .send({ label: '打伞' });
    expect(resLimited.status).to.equal(429);
    expect(resLimited.headers['retry-after']).to.equal('5');
    expect(resLimited.body.error.code).to.equal('PICTOGRAM_RATE_LIMITED');
  });

  it('serves /health, /parts/search, and hardened /parts/:partId/svg headers', async function () {
    const health = await request(app).get('/pictograms/v2/health');
    expect(health.status).to.equal(200);
    expect(health.body.ok).to.equal(true);
    expect(health.body.partCount).to.equal(3436);

    const search = await request(app).get('/pictograms/v2/parts/search?q=' + encodeURIComponent('眼镜盒') + '&limit=5');
    expect(search.status).to.equal(200);
    expect(search.body.results.candidates.length).to.be.greaterThan(0);
    expect(search.body.decomposition.matchedParts.some(p => p.partId === 'glasses')).to.equal(true);

    const svgRes = await request(app).get('/pictograms/v2/parts/glasses/svg');
    expect(svgRes.status).to.equal(200);
    expect(svgRes.headers['content-type']).to.include('image/svg+xml');
    expect(svgRes.headers['content-security-policy']).to.include("default-src 'none'");
    const svgText = svgRes.text || (Buffer.isBuffer(svgRes.body) ? svgRes.body.toString('utf8') : String(svgRes.body || ''));
    expect(svgText).to.include('<svg');

    const badId = await request(app).get('/pictograms/v2/parts/..%5Csecret/svg');
    expect([400, 404]).to.include(badId.status);

    const missingPart = await request(app).get('/pictograms/v2/parts/does_not_exist_123/svg');
    expect(missingPart.status).to.equal(404);
  });

  it('composes Tier-1 micro-GIF via POST /compose and runs full resolve -> confirm -> cache hit -> delete lifecycle', async function () {
    const composed = await request(app)
      .post('/pictograms/v2/compose')
      .set('Authorization', 'Bearer token-user-a')
      .send({ label: '打伞' });

    expect(composed.status).to.equal(200);
    expect(composed.body.mediaType).to.equal('gif');
    expect(composed.body.mimeType).to.equal('image/gif');
    expect(composed.body.license).to.equal('CC BY-SA 2.0');
    expect(isGif89aBuffer(Buffer.from(composed.body.imageBase64, 'base64'))).to.equal(true);
    expect(composed.body.svg).to.include('<svg');

    const resolved1 = await request(app)
      .post('/pictograms/v2/resolve')
      .set('Authorization', 'Bearer token-user-a')
      .send({ label: '眼镜盒' });
    expect(resolved1.status).to.equal(200);
    expect(resolved1.body.cacheHit).to.equal(false);
    expect(resolved1.body.tier).to.equal('tier1_composed');

    const confirmed = await request(app)
      .post('/pictograms/v2/confirm')
      .set('Authorization', 'Bearer token-user-a')
      .send({
        label: '眼镜盒',
        mimeType: resolved1.body.mimeType,
        imageBase64: resolved1.body.imageBase64,
        svg: resolved1.body.svg,
        tier: resolved1.body.tier,
        license: resolved1.body.license,
        attribution: resolved1.body.attribution
      });
    expect(confirmed.status).to.equal(200);
    expect(confirmed.body.saved).to.equal(true);

    const resolved2 = await request(app)
      .post('/pictograms/v2/resolve')
      .set('Authorization', 'Bearer token-user-a')
      .send({ label: '眼镜盒' });
    expect(resolved2.status).to.equal(200);
    expect(resolved2.body.status).to.equal('cache_hit');
    expect(resolved2.body.tier).to.equal('cached_confirmed');
    expect(resolved2.body.cacheHit).to.equal(true);
    expect(resolved2.body.hitCount).to.equal(1);

    const listRes = await request(app)
      .get('/pictograms/v2/confirmed')
      .set('Authorization', 'Bearer token-user-a');
    expect(listRes.status).to.equal(200);
    expect(listRes.body.items).to.have.lengthOf(1);
    expect(listRes.body.items[0].normalized_label).to.equal('眼镜盒');

    const delRes = await request(app)
      .delete('/pictograms/v2/confirmed/' + encodeURIComponent('眼镜盒'))
      .set('Authorization', 'Bearer token-user-a');
    expect(delRes.status).to.equal(200);
    expect(delRes.body.deleted).to.equal(true);

    const listAfter = await request(app)
      .get('/pictograms/v2/confirmed')
      .set('Authorization', 'Bearer token-user-a');
    expect(listAfter.status).to.equal(200);
    expect(listAfter.body.items).to.have.lengthOf(0);
  });

  it('isolates SQLite confirmed cache scopes by authenticated user even if body.scopeId is spoofed', async function () {
    const scopeA = deriveUserScopeId({ id: 'user-a-001' });

    const resA = await request(app)
      .post('/pictograms/v2/resolve')
      .set('Authorization', 'Bearer token-user-a')
      .send({ label: '眼镜盒' });
    await request(app)
      .post('/pictograms/v2/confirm')
      .set('Authorization', 'Bearer token-user-a')
      .send({
        label: '眼镜盒',
        mimeType: resA.body.mimeType,
        imageBase64: resA.body.imageBase64,
        tier: resA.body.tier
      });

    // User B maliciously tries to pass User A's scopeId in body
    const resB = await request(app)
      .post('/pictograms/v2/resolve')
      .set('Authorization', 'Bearer token-user-b')
      .send({ label: '眼镜盒', scopeId: scopeA });
    expect(resB.status).to.equal(200);
    expect(resB.body.cacheHit).to.equal(false);

    const listB = await request(app)
      .get('/pictograms/v2/confirmed?scopeId=' + encodeURIComponent(scopeA))
      .set('Authorization', 'Bearer token-user-b');
    expect(listB.status).to.equal(200);
    expect(listB.body.scopeId).to.not.equal(scopeA);
    expect(listB.body.items).to.have.lengthOf(0);
  });

  it('enforces Stage 3 blind-VLM circuit breaker, 422 cache reject, and 403 personal photo block via HTTP', async function () {
    const spritePng = await makeWideSpritePng();
    runtime.close();
    runtime = createDefaultPictogramCompositionRuntime({
      cacheDbPath: ':memory:',
      vectorizer: createPictogramVectorizer(),
      imageEditClient: {
        async editFromReference() {
          return { rawImageBuffer: spritePng, usage: { total_tokens: 1 } };
        }
      },
      vlmClient: {
        chat: {
          completions: {
            async create() {
              // Negation swallowed: guesses "吃药" instead of "不想吃药"
              return { choices: [{ message: { content: '1. 吃药\n2. 药片\n3. 吞咽' } }] };
            }
          }
        }
      }
    });
    app = mountRouter();

    const privacyRes = await request(app)
      .post('/pictograms/v2/resolve')
      .set('Authorization', 'Bearer token-user-a')
      .send({ label: '打伞', forceRefinement: true, containsPersonalPhoto: true });
    expect(privacyRes.status).to.equal(403);
    expect(privacyRes.body.error.code).to.equal('PRIVACY_PERSONAL_PHOTO_BLOCKED');

    const brokenRes = await request(app)
      .post('/pictograms/v2/resolve')
      .set('Authorization', 'Bearer token-user-a')
      .send({ label: '不想吃药', forceRefinement: true, isAnimatedAction: true });
    expect(brokenRes.status).to.equal(200);
    expect(brokenRes.body.status).to.equal('circuit_broken');
    expect(brokenRes.body.circuitBroken).to.equal(true);
    expect(brokenRes.body.blockedImageNotReturned).to.equal(true);
    expect(brokenRes.body.imageBase64).to.equal(null);

    const png1x1 = await sharp({
      create: { width: 100, height: 100, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
    })
      .png()
      .toBuffer();

    const rejectConfirm = await request(app)
      .post('/pictograms/v2/confirm')
      .set('Authorization', 'Bearer token-user-a')
      .send({
        label: '不想吃药',
        mimeType: 'image/png',
        imageBase64: png1x1.toString('base64'),
        iconicity: { passed: false, reason: 'negation_swallowed' }
      });
    expect(rejectConfirm.status).to.equal(422);
    expect(rejectConfirm.body.error.code).to.equal('ICONICITY_GATE_REJECTED');
  });

  it('mounts clean local caregiver trial workbench HTML and v2 API routes', async function () {
    const wb = createWorkbenchApp({ dbPath: ':memory:' });
    try {
      const htmlRes = await request(wb.app).get('/');
      expect(htmlRes.status).to.equal(200);
      expect(htmlRes.headers['content-type']).to.include('text/html');
      expect(htmlRes.text).to.include('图语家 AAC 缺词补图照护者试用工作台');

      const apiHealth = await request(wb.app).get('/api/pictograms/v2/health');
      expect(apiHealth.status).to.equal(200);
      expect(apiHealth.body.partCount).to.equal(3436);
    } finally {
      wb.close();
    }
  });
});

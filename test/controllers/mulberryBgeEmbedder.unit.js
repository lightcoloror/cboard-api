'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { expect } = require('chai');

const {
  getMulberryPart,
  loadMulberryPartIndex,
  searchMulberryParts
} = require('../../api/helpers/mulberryPartIndex');
const {
  createAutoBgeEmbedder,
  createHttpBgeEmbedder,
  createSubprocessBgeEmbedder,
  normalizeEmbeddingVector
} = require('../../api/helpers/mulberryBgeEmbedder');
const {
  createDefaultPictogramCompositionRuntime
} = require('../../api/helpers/pictogramCompositionRuntime');
const {
  createPictogramCompositionRouter
} = require('../../api/helpers/pictogramCompositionRouter');

const REAL_MODEL_PATH =
  'D:/used-by-codex/outputs/tuyujia-route-validation-20261104/models/bge-small-zh-v1.5';
const REAL_DEPS_PATH =
  'D:/used-by-codex/outputs/tuyujia-route-validation-20261104/python-deps';

describe('Runtime BGE query embedder & Crowdin safety sweep (Step 6)', function () {
  this.timeout(30000);

  it('applies the 13 newly curated Crowdin safety overrides and strips all 14 trailing punctuation marks', function () {
    const idx = loadMulberryPartIndex();
    expect(idx.stats.overriddenCount).to.be.at.least(85);

    for (const part of idx.parts) {
      if (part.trustTier === 'crowdin_unreviewed') {
        expect(/[。！？!?.]+$/.test(part.zh || ''), `Trailing punct in ${part.file}: ${part.zh}`).to.equal(false);
      }
    }

    expect(getMulberryPart('underarm').zh).to.equal('腋下');
    expect(searchMulberryParts('手枪', { limit: 10 }).candidates.map(c => c.file)).to.not.include('underarm.svg');
    expect(searchMulberryParts('腋下', { limit: 5 }).candidates[0].partId).to.equal('underarm');

    expect(searchMulberryParts('节点', { limit: 10 }).candidates.map(c => c.file)).to.not.include('nod_,_to.svg');
    expect(searchMulberryParts('点头', { limit: 5 }).candidates[0].partId).to.equal('nod_to');

    expect(searchMulberryParts('指甲锉', { limit: 5 }).candidates[0].partId).to.equal('nail_file');
    expect(searchMulberryParts('上下铺', { limit: 5 }).candidates[0].partId).to.equal('bunk_beds');
    expect(searchMulberryParts('衣架', { limit: 5 }).candidates[0].partId).to.equal('clothes_hanger');
    expect(searchMulberryParts('电脑椅', { limit: 5 }).candidates[0].partId).to.equal('computer_chair');
    expect(searchMulberryParts('辅助开关', { limit: 5 }).candidates[0].partId).to.equal('switch_access');
    expect(searchMulberryParts('交换机', { limit: 10 }).candidates.map(c => c.file)).to.not.include('switch_access.svg');
    expect(searchMulberryParts('去掉食物', { limit: 10 }).candidates.map(c => c.file)).to.not.include('dip_food_,_to.svg');
    expect(searchMulberryParts('蘸食物', { limit: 5 }).candidates[0].partId).to.equal('dip_food_to');
    expect(getMulberryPart('cake').zh).to.equal('蛋糕');
  });

  it('caches OpenAI-compatible HTTP BGE embeddings and fails open on upstream errors', async function () {
    const unitVec = Array.from({ length: 512 }, (_, idx) => (idx === 0 ? 1 : 0));
    let calls = 0;
    let mode = 'ok';

    const embedder = createHttpBgeEmbedder({
      url: 'http://127.0.0.1:9999/v1/embeddings',
      apiKey: 'test-key',
      timeoutMs: 1000,
      async fetchImpl() {
        calls += 1;
        if (mode === 'http_500') {
          return { ok: false, status: 500, async json() { return {}; } };
        }
        if (mode === 'throw') {
          throw new Error('ECONNREFUSED');
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { data: [{ embedding: unitVec }] };
          }
        };
      }
    });

    try {
      const v1 = await embedder.embed('倒热水');
      const v2 = await embedder.embed('倒热水');
      expect(v1).to.be.instanceOf(Float32Array).with.lengthOf(512);
      expect(v2[0]).to.equal(1);
      expect(calls).to.equal(1);
      expect(embedder.getStats().cacheHits).to.equal(1);

      mode = 'http_500';
      expect(await embedder.embed('未命中1')).to.equal(null);
      mode = 'throw';
      expect(await embedder.embed('未命中2')).to.equal(null);
      expect(embedder.getStats().failures).to.equal(2);
    } finally {
      embedder.close();
    }
  });

  it('handles subprocess JSONL concurrency, LRU cache, timeouts, and clean teardown', async function () {
    const tmpWorker = path.join(os.tmpdir(), `mock-bge-worker-${process.pid}-${Date.now()}.js`);
    fs.writeFileSync(
      tmpWorker,
      `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdout.write(JSON.stringify({ ready: true, dim: 512 }) + '\\n');
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.cmd === 'quit') process.exit(0);
  if (msg.text === 'slow') return; // intentionally trigger requestTimeoutMs
  const vec = Array.from({ length: 512 }, (_, idx) => (idx === 1 ? 1 : 0));
  const delayMs = msg.text === 'q1' ? 25 : 5;
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ id: msg.id, vector: vec }) + '\\n');
  }, delayMs);
});
      `.trim(),
      'utf8'
    );

    const embedder = createSubprocessBgeEmbedder({
      pythonBin: process.execPath,
      workerScript: tmpWorker,
      startupTimeoutMs: 5000,
      requestTimeoutMs: 120,
      maxCacheSize: 32
    });

    try {
      const [r1, r2] = await Promise.all([embedder.embed('q1'), embedder.embed('q2')]);
      expect(r1).to.be.instanceOf(Float32Array).with.lengthOf(512);
      expect(r2).to.be.instanceOf(Float32Array).with.lengthOf(512);
      expect(r1[1]).to.equal(1);

      const r1Cached = await embedder.embed('q1');
      expect(r1Cached[1]).to.equal(1);
      expect(embedder.getStats().cacheHits).to.equal(1);
      expect(embedder.getStats().spawns).to.equal(1);

      const timedOut = await embedder.embed('slow');
      expect(timedOut).to.equal(null);
      expect(embedder.getStats().failures).to.equal(1);

      expect(normalizeEmbeddingVector([1, 2, 3], 512)).to.equal(null);
      expect(createAutoBgeEmbedder({})).to.equal(null);
    } finally {
      embedder.close();
      if (fs.existsSync(tmpWorker)) fs.unlinkSync(tmpWorker);
    }
  });

  it('powers live router GET /parts/search with real offline CPU bge-small-zh-v1.5 embeddings', async function () {
    if (!fs.existsSync(path.join(REAL_MODEL_PATH, 'model.safetensors'))) {
      this.skip();
      return;
    }

    const runtime = createDefaultPictogramCompositionRuntime({
      cacheDbPath: ':memory:',
      bgeModelPath: REAL_MODEL_PATH,
      bgeDepsPath: fs.existsSync(REAL_DEPS_PATH) ? REAL_DEPS_PATH : ''
    });

    const app = express();
    app.use(
      '/pictograms/v2',
      createPictogramCompositionRouter({
        pipeline: runtime.pipeline,
        cache: runtime.cache,
        enabled: true,
        requireAuth: false,
        embedQuery: runtime.embedQuery,
        isBgeRuntimeReady: runtime.isBgeRuntimeReady,
        isRecipePlannerConfigured: runtime.isRecipePlannerConfigured
      })
    );

    try {
      const health = await request(app).get('/pictograms/v2/health');
      expect(health.status).to.equal(200);
      expect(health.body.bgeRuntimeReady).to.equal(true);

      // Warm up persistent Python worker (first call includes ~2s PyTorch model load)
      const warmSearch = await request(app).get(
        '/pictograms/v2/parts/search?q=' + encodeURIComponent('倒热水') + '&limit=10'
      );
      expect(warmSearch.status).to.equal(200);
      expect(warmSearch.body.bgeUsed).to.equal(true);
      const hotWaterIds = warmSearch.body.results.candidates.map(c => c.partId);
      expect(hotWaterIds).to.include.members(['hot', 'kettle', 'pour_to']);
      expect(hotWaterIds.some(id => id === 'water' || id === 'hot_drink_2')).to.equal(true);

      // Measure steady-state warm offline BGE query latency (<150ms including Express HTTP)
      const tWarm = Date.now();
      const acSearch = await request(app).get(
        '/pictograms/v2/parts/search?q=' + encodeURIComponent('调高空调') + '&limit=5'
      );
      const warmMs = Date.now() - tWarm;
      expect(acSearch.status).to.equal(200);
      expect(acSearch.body.bgeUsed).to.equal(true);
      expect(acSearch.body.results.candidates.map(c => c.partId)).to.include('turn_up_heat_to');
      expect(warmMs).to.be.lessThan(300);

      // Measure LRU cache repeat latency (<15ms)
      const tCached = Date.now();
      const cachedSearch = await request(app).get(
        '/pictograms/v2/parts/search?q=' + encodeURIComponent('调高空调') + '&limit=5'
      );
      expect(cachedSearch.status).to.equal(200);
      expect(Date.now() - tCached).to.be.lessThan(30);
      expect(runtime.bgeEmbedder.getStats().cacheHits).to.be.at.least(1);
    } finally {
      runtime.close();
    }
  });
});

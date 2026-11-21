'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const {
  createDefaultPictogramCompositionRuntime
} = require('../api/helpers/pictogramCompositionRuntime');
const {
  createPictogramCompositionRouter
} = require('../api/helpers/pictogramCompositionRouter');

function buildWorkbenchHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>图语家 AAC 缺词补图工作台 (Step 4 Trial Workbench)</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card: #ffffff;
      --ink: #0f172a;
      --muted: #475569;
      --border: #cbd5e1;
      --accent: #0284c7;
      --accent-soft: #e0f2fe;
      --ok: #15803d;
      --warn: #b45309;
      --danger: #b91c1c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: var(--bg);
      color: var(--ink);
      font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
    }
    .container { max-width: 1120px; margin: 0 auto; display: grid; gap: 20px; }
    .header {
      background: var(--card);
      border: 2px solid var(--border);
      border-radius: 16px;
      padding: 18px 22px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }
    .header h1 { margin: 0 0 4px 0; font-size: 20px; }
    .sub { color: var(--muted); font-size: 13px; margin: 0; }
    .pill {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      background: var(--accent-soft);
      color: var(--accent);
    }
    .grid { display: grid; grid-template-columns: 1.25fr 1fr; gap: 20px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
    .panel {
      background: var(--card);
      border: 2px solid var(--border);
      border-radius: 16px;
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .panel h2 { margin: 0; font-size: 16px; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    input[type="text"] {
      flex: 1;
      min-width: 180px;
      padding: 10px 12px;
      border: 2px solid var(--border);
      border-radius: 10px;
      font-size: 15px;
    }
    button {
      padding: 9px 14px;
      border-radius: 10px;
      border: 2px solid var(--accent);
      background: var(--accent);
      color: #fff;
      font-weight: 700;
      cursor: pointer;
      font-size: 13px;
    }
    button.secondary {
      background: #fff;
      color: var(--ink);
      border-color: var(--border);
    }
    button.ok { background: var(--ok); border-color: var(--ok); }
    button.danger { background: #fff; color: var(--danger); border-color: #fecaca; }
    .presets { display: flex; gap: 8px; flex-wrap: wrap; }
    .preset-btn {
      background: #f1f5f9;
      color: var(--ink);
      border: 1px solid var(--border);
      padding: 6px 10px;
      font-size: 12px;
    }
    .preview-wrap {
      display: grid;
      grid-template-columns: 240px 1fr;
      gap: 16px;
      align-items: start;
      border-top: 1px solid #e2e8f0;
      padding-top: 14px;
    }
    .preview-box {
      width: 240px;
      min-height: 240px;
      border: 2px dashed var(--border);
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #fff;
      padding: 10px;
    }
    .preview-box img { max-width: 220px; max-height: 220px; display: block; }
    .meta { font-size: 13px; color: var(--muted); line-height: 1.7; }
    .meta strong { color: var(--ink); }
    .parts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
      gap: 10px;
    }
    .part-card {
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 8px;
      text-align: center;
      background: #fff;
      font-size: 12px;
    }
    .part-card img { width: 56px; height: 56px; object-fit: contain; display: block; margin: 0 auto 6px; }
    .cache-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 10px;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      font-size: 13px;
    }
    .circuit-broken {
      border: 2px solid #f59e0b;
      background: #fffbeb;
      color: #92400e;
      border-radius: 12px;
      padding: 14px;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1>图语家 AAC 缺词补图照护者试用工作台</h1>
        <p class="sub">Tier-1 0-Token Mulberry 部件拼图 + 微动图 + SQLite 已确认词卡飞轮（本地回环试用）</p>
      </div>
      <div class="pill" id="healthStatus">正在检测服务...</div>
    </div>

    <div class="grid">
      <div class="panel">
        <h2>1. 缺词拼图与确认闭环</h2>
        <div class="row">
          <input id="labelInput" type="text" maxlength="24" value="眼镜盒" placeholder="输入缺少图卡的词，如：眼镜盒 / 打伞" />
          <button id="resolveBtn">生成预览</button>
          <button id="composeStaticBtn" class="secondary">静态图</button>
          <button id="confirmBtn" class="ok" disabled>确认入库</button>
        </div>
        <div class="presets">
          <button class="preset-btn" data-word="打伞">打伞</button>
          <button class="preset-btn" data-word="眼镜盒">眼镜盒</button>
          <button class="preset-btn" data-word="血糖试纸">血糖试纸</button>
          <button class="preset-btn" data-word="不想吃药">不想吃药</button>
          <button class="preset-btn" data-word="轮椅坐垫">轮椅坐垫</button>
          <button class="preset-btn" data-word="买水果">买水果</button>
          <button class="preset-btn" data-word="去医院">去医院</button>
          <button class="preset-btn" data-word="充电线">充电线</button>
        </div>
        <div id="previewArea" class="preview-wrap">
          <div class="preview-box" id="previewBox">等待生成...</div>
          <div class="meta" id="previewMeta">输入词语并点击“生成预览”。</div>
        </div>
      </div>

      <div class="panel">
        <h2>2. 已确认家庭词库 (SQLite)</h2>
        <div class="row">
          <button id="refreshCacheBtn" class="secondary">刷新已确认列表</button>
        </div>
        <div id="cacheList">暂无已确认词卡</div>
      </div>
    </div>

    <div class="panel">
      <h2>3. Mulberry 3,436 清洁部件检索预览</h2>
      <div class="row">
        <input id="partQueryInput" type="text" maxlength="40" value="眼镜盒" placeholder="搜索部件语义（支持中文/同义词/语义扩展）" />
        <button id="partSearchBtn" class="secondary">检索部件</button>
      </div>
      <div id="partsGrid" class="parts-grid"></div>
    </div>
  </div>

  <script>
    const API_BASE = '/api/pictograms/v2';
    let lastResult = null;

    async function loadHealth() {
      try {
        const res = await fetch(API_BASE + '/health');
        const data = await res.json();
        document.getElementById('healthStatus').textContent =
          '部件库 ' + data.partCount + ' · Tier-1 就绪 · 缓存 ' + (data.cacheReady ? '开启' : '关闭');
      } catch (e) {
        document.getElementById('healthStatus').textContent = '服务不可用';
      }
    }

    function renderResult(data) {
      lastResult = data;
      const box = document.getElementById('previewBox');
      const meta = document.getElementById('previewMeta');
      const confirmBtn = document.getElementById('confirmBtn');
      box.textContent = '';

      if (data.circuitBroken) {
        const div = document.createElement('div');
        div.className = 'circuit-broken';
        div.textContent = '已触发安全熔断：仅显示高对比文字卡「' + data.label + '」';
        box.appendChild(div);
        confirmBtn.disabled = true;
      } else if (data.imageBase64 && data.mimeType) {
        const img = document.createElement('img');
        img.src = 'data:' + data.mimeType + ';base64,' + data.imageBase64;
        img.alt = data.label;
        box.appendChild(img);
        confirmBtn.disabled = false;
      } else {
        box.textContent = '无可用图像';
        confirmBtn.disabled = true;
      }

      const lines = [
        '<strong>词语：</strong>' + (data.label || '-'),
        '<strong>状态 / 层级：</strong>' + (data.status || '-') + ' / ' + (data.tier || '-'),
        '<strong>缓存命中：</strong>' + (data.cacheHit ? '是 (hit=' + (data.hitCount || 1) + ')' : '否'),
        '<strong>媒体类型：</strong>' + (data.mimeType || '-'),
        '<strong>需升级 Tier-2 基准重绘：</strong>' + (data.needsRegenFallback ? '建议重绘' : 'Tier-1 已可用'),
        '<strong>耗时：</strong>' + (data.metrics && data.metrics.totalMs != null ? data.metrics.totalMs + ' ms' : (data.metrics && data.metrics.renderMs != null ? data.metrics.renderMs + ' ms' : '-')),
        '<strong>许可署名：</strong>' + (data.license || '-')
      ];
      meta.innerHTML = lines.join('<br/>');
    }

    async function resolveWord(label) {
      const res = await fetch(API_BASE + '/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label })
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data.error && data.error.message) || '生成失败');
      renderResult(data);
    }

    async function composeStatic(label) {
      const res = await fetch(API_BASE + '/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, preferStatic: true })
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data.error && data.error.message) || '生成失败');
      renderResult(data);
    }

    async function confirmCurrent() {
      if (!lastResult || !lastResult.imageBase64) return;
      const res = await fetch(API_BASE + '/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: lastResult.label,
          mimeType: lastResult.mimeType,
          imageBase64: lastResult.imageBase64,
          svg: lastResult.svg,
          tier: lastResult.tier || 'tier1_composed',
          recipe: lastResult.recipe,
          license: lastResult.license,
          attribution: lastResult.attribution
        })
      });
      if (res.ok) {
        await refreshCache();
      }
    }

    async function refreshCache() {
      const res = await fetch(API_BASE + '/confirmed');
      const data = await res.json();
      const wrap = document.getElementById('cacheList');
      wrap.textContent = '';
      const items = (data && data.items) || [];
      if (!items.length) {
        wrap.textContent = '暂无已确认词卡';
        return;
      }
      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'cache-item';
        const info = document.createElement('span');
        info.textContent = item.normalized_label + ' [' + item.media_type + ' / 命中 ' + item.hit_count + ']';
        const del = document.createElement('button');
        del.className = 'danger';
        del.textContent = '删除';
        del.onclick = async () => {
          await fetch(API_BASE + '/confirmed/' + encodeURIComponent(item.normalized_label), { method: 'DELETE' });
          await refreshCache();
        };
        row.appendChild(info);
        row.appendChild(del);
        wrap.appendChild(row);
      }
    }

    async function searchParts(q) {
      const res = await fetch(API_BASE + '/parts/search?q=' + encodeURIComponent(q) + '&limit=8');
      const data = await res.json();
      const grid = document.getElementById('partsGrid');
      grid.textContent = '';
      const list = (data.results && data.results.candidates) || [];
      for (const p of list) {
        const card = document.createElement('div');
        card.className = 'part-card';
        const img = document.createElement('img');
        img.src = API_BASE + '/parts/' + encodeURIComponent(p.partId) + '/svg';
        img.alt = p.zh || p.partId;
        const cap = document.createElement('div');
        cap.textContent = (p.zh || p.partId) + ' (' + p.score + ')';
        card.appendChild(img);
        card.appendChild(cap);
        grid.appendChild(card);
      }
    }

    document.getElementById('resolveBtn').onclick = () => resolveWord(document.getElementById('labelInput').value);
    document.getElementById('composeStaticBtn').onclick = () => composeStatic(document.getElementById('labelInput').value);
    document.getElementById('confirmBtn').onclick = confirmCurrent;
    document.getElementById('refreshCacheBtn').onclick = refreshCache;
    document.getElementById('partSearchBtn').onclick = () => searchParts(document.getElementById('partQueryInput').value);
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.onclick = () => {
        const w = btn.getAttribute('data-word');
        document.getElementById('labelInput').value = w;
        document.getElementById('partQueryInput').value = w;
        resolveWord(w);
        searchParts(w);
      };
    });

    loadHealth();
    refreshCache();
    resolveWord('眼镜盒');
    searchParts('眼镜盒');
  </script>
</body>
</html>`;
}

function createWorkbenchApp({
  dbPath = ':memory:',
  imageEditClient = null,
  vlmClient = null,
  vectorizerOptions
} = {}) {
  const runtime = createDefaultPictogramCompositionRuntime({
    cacheDbPath: dbPath,
    imageEditClient,
    vlmClient,
    vectorizerOptions
  });

  const app = express();
  app.use(
    '/api/pictograms/v2',
    createPictogramCompositionRouter({
      pipeline: runtime.pipeline,
      cache: runtime.cache,
      enabled: true,
      requireAuth: false,
      allowClientScopeInDev: true,
      allowedOrigins: [],
      isTier2Configured: runtime.isTier2Configured
    })
  );

  const html = buildWorkbenchHtml();
  app.get('/', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    res.status(200).send(html);
  });

  return {
    app,
    runtime,
    close() {
      runtime.close();
    }
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dbFlagIdx = args.indexOf('--db');
  const dbPath =
    dbFlagIdx !== -1 && args[dbFlagIdx + 1]
      ? path.resolve(args[dbFlagIdx + 1])
      : path.join(os.tmpdir(), 'tuyujia-pictogram-workbench.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const port = Number(process.env.PORT || 4173);
  const workbench = createWorkbenchApp({ dbPath });
  const server = workbench.app.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    console.log(`Tuyujia Pictogram Workbench listening at http://127.0.0.1:${addr.port}/ (db: ${dbPath})`);
  });

  const shutdown = () => {
    server.close(() => {
      workbench.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  buildWorkbenchHtml,
  createWorkbenchApp
};

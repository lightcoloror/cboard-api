'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const API_ROOT = path.resolve(__dirname, '..');
const CBOARD_ROOT = path.resolve(API_ROOT, '../cboard');
const SVGO = require(path.join(CBOARD_ROOT, 'node_modules/svgo'));
const sharp = require('sharp');

const MULBERRY_JSON_PATH = path.join(CBOARD_ROOT, 'src/api/mulberry-symbols.json');
const MULBERRY_SVG_DIR = path.join(CBOARD_ROOT, 'public/symbols/mulberry');
const EN_US_PATH = path.join(CBOARD_ROOT, 'src/translations/en-US.json');
const ZH_CN_PATH = path.join(CBOARD_ROOT, 'src/translations/zh-CN.json');
const ZH_REVIEW_PATH = path.join(CBOARD_ROOT, 'src/translations/zh-CN.aac-review.json');
const BOARDS_PATH = path.join(CBOARD_ROOT, 'src/api/boards.json');
const OVERRIDES_PATH = path.join(API_ROOT, 'api/data/mulberryPartSenseOverrides.json');

const OUT_INDEX_PATH = path.join(API_ROOT, 'api/data/mulberrySymbolPartIndex.json');
const OUT_SVGS_GZ_PATH = path.join(API_ROOT, 'api/data/mulberryCleanSvgs.json.gz');

function parseArgs(argv) {
  let auditDir = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--audit-dir' && argv[i + 1]) {
      auditDir = argv[i + 1];
      i += 1;
    }
  }
  return { auditDir };
}

function parseViewBox(svgStr) {
  const m = svgStr.match(/viewBox="([^"]+)"/i);
  if (!m) return [0, 0, 850.394, 850.394];
  const parts = m[1].trim().split(/[\s,]+/).map(Number);
  return parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0
    ? parts
    : [0, 0, 850.394, 850.394];
}

function normalizeLemmaEn(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/^to\s+/, '');
}

function inferPartRole(symbolId, domain, file, en, zh) {
  const lowEn = String(en || '').toLowerCase();
  const lowFile = String(file || '').toLowerCase();
  const lowDom = String(domain || '').toLowerCase();
  if (lowFile.endsWith('_,_to.svg') || lowEn.startsWith('to ') || lowDom.includes('actions')) {
    return 'verb_action';
  }
  if (lowDom === 'healthcarebodyparts' || lowDom === 'animalfeatures') {
    return 'body_part';
  }
  if (lowDom === 'healthcaremedicalitems' || lowDom === 'healthcaremedicalconditions') {
    return 'medical_item';
  }
  if (
    lowDom === 'peopleprofession' ||
    lowDom === 'peoplerelationship' ||
    lowDom === 'peopledescriptive' ||
    lowDom === 'peoplenoun'
  ) {
    return 'person_role';
  }
  if (lowDom.startsWith('descriptive') || lowDom === 'peoplefeelings' || lowDom === 'artcolour') {
    return 'state_modifier';
  }
  if (
    /\b(box|bag|basket|jar|bottle|cupboard|bucket|bin|drawer|folder|wallet|purse|suitcase)\b/i.test(lowEn) ||
    /(盒|箱|包|瓶|袋|柜|桶|篮|夹)$/.test(String(zh || ''))
  ) {
    return 'container';
  }
  return 'object_entity';
}

function makePartId(fileName, seenIds) {
  const base = path.basename(fileName, '.svg')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'part';
  if (!seenIds.has(base)) {
    seenIds.add(base);
    return base;
  }
  let n = 2;
  while (seenIds.has(`${base}_${n}`)) n += 1;
  const uniq = `${base}_${n}`;
  seenIds.add(uniq);
  return uniq;
}

function injectSvgSizeForTrim(svgStr, rw, rh) {
  return svgStr.replace(/<svg\b([^>]*)>/i, (full, attrs) => {
    const clean = attrs
      .replace(/\s*(width|height|preserveAspectRatio)="[^"]*"/gi, '');
    return `<svg${clean} width="${rw}" height="${rh}" preserveAspectRatio="none">`;
  });
}

function replaceViewBox(svgStr, vbStr) {
  if (/viewBox="[^"]*"/i.test(svgStr)) {
    return svgStr.replace(/viewBox="[^"]*"/i, `viewBox="${vbStr}"`);
  }
  return svgStr.replace(/<svg\b/i, `<svg viewBox="${vbStr}"`);
}

async function processOneSvg(entry, ctx) {
  const srcPath = path.join(MULBERRY_SVG_DIR, entry.file);
  const rawBuf = fs.readFileSync(srcPath);
  const raw = rawBuf.toString('utf8');
  const sha256 = crypto.createHash('sha256').update(rawBuf).digest('hex');
  const origViewBox = parseViewBox(raw);
  const [ox, oy, ow, oh] = origViewBox;
  const hasStyleTag = /<style\b/i.test(raw);
  const hasDefsId = /\bid="/i.test(raw);
  const isNonStdVb = !/viewBox="0 0 850\.394 850\.394"/.test(raw);
  const isNonSquareVb = Math.abs(ow - oh) > 1.0 || Math.abs(ox) > 0.1 || Math.abs(oy) > 0.1;

  const svgo = new SVGO({
    full: true,
    plugins: [
      { removeDoctype: true },
      { removeXMLProcInst: true },
      { removeComments: true },
      { removeMetadata: true },
      { removeEditorsNSData: true },
      { inlineStyles: { onlyMatchedOnce: false } },
      { convertStyleToAttrs: true },
      { minifyStyles: true },
      { prefixIds: { prefix: `mp_${entry.partId}` } },
      { removeUselessDefs: true },
      { cleanupNumericValues: { floatPrecision: 2 } },
      { removeDimensions: true }
    ]
  });

  const opt = await svgo.optimize(raw);
  const hasDotStRemaining = /\.st\d+/.test(opt.data);
  const hasClassRemaining = /\bclass="/.test(opt.data);

  const maxSide = Math.max(ow, oh);
  const rw = Math.max(32, Math.round((256 * ow) / maxSide));
  const rh = Math.max(32, Math.round((256 * oh) / maxSide));
  const trimInputSvg = injectSvgSizeForTrim(opt.data, rw, rh);

  let tightViewBox = origViewBox.map(n => +n.toFixed(2));
  let contentRatio = 1.0;
  let trimFallback = false;

  try {
    const flatPng = await sharp(Buffer.from(trimInputSvg))
      .resize(rw, rh, { fit: 'fill' })
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer();

    const trimmed = await sharp(flatPng)
      .trim({ threshold: 4 })
      .toBuffer({ resolveWithObject: true });

    const leftPx = Math.max(0, -(trimmed.info.trimOffsetLeft || 0));
    const topPx = Math.max(0, -(trimmed.info.trimOffsetTop || 0));
    const padPx = 5;
    const x0Px = Math.max(0, leftPx - padPx);
    const y0Px = Math.max(0, topPx - padPx);
    const x1Px = Math.min(rw, leftPx + trimmed.info.width + padPx);
    const y1Px = Math.min(rh, topPx + trimmed.info.height + padPx);

    const sx = ow / rw;
    const sy = oh / rh;
    const vbX = +(ox + x0Px * sx).toFixed(2);
    const vbY = +(oy + y0Px * sy).toFixed(2);
    const vbW = +(Math.max(1, x1Px - x0Px) * sx).toFixed(2);
    const vbH = +(Math.max(1, y1Px - y0Px) * sy).toFixed(2);

    tightViewBox = [vbX, vbY, vbW, vbH];
    contentRatio = +((trimmed.info.width * trimmed.info.height) / (rw * rh)).toFixed(4);
  } catch (err) {
    trimFallback = true;
    ctx.trimFailures.push({ file: entry.file, error: String(err && err.message ? err.message : err) });
  }

  const tightVbStr = tightViewBox.join(' ');
  const finalSvg = replaceViewBox(opt.data, tightVbStr);

  return {
    partRecord: {
      partId: entry.partId,
      file: entry.file,
      symbolId: entry.symbolId,
      domain: entry.domain,
      src: entry.src,
      en: entry.en,
      zh: entry.zh,
      zhRaw: entry.zhRaw,
      synonymsZh: entry.synonymsZh,
      excludeQueries: entry.excludeQueries,
      partRole: entry.partRole,
      inDefaultBoards: entry.inDefaultBoards,
      inAacReview: entry.inAacReview,
      hasOverride: entry.hasOverride,
      trustTier: entry.trustTier,
      autoComposeAllowed: entry.autoComposeAllowed,
      suspectReasons: entry.suspectReasons,
      homographStem: entry.homographStem,
      origViewBox: origViewBox.map(n => +n.toFixed(3)),
      tightViewBox,
      contentRatio,
      trimFallback,
      hasStyleTag,
      hasDefsId,
      isNonStdVb,
      isNonSquareVb,
      hasDotStRemaining,
      hasClassRemaining,
      rawBytes: rawBuf.length,
      cleanBytes: Buffer.byteLength(finalSvg, 'utf8'),
      sha256
    },
    finalSvg
  };
}

async function main() {
  const { auditDir } = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  const mulberryList = JSON.parse(fs.readFileSync(MULBERRY_JSON_PATH, 'utf8'));
  const enMap = JSON.parse(fs.readFileSync(EN_US_PATH, 'utf8'));
  const zhMap = JSON.parse(fs.readFileSync(ZH_CN_PATH, 'utf8'));
  const zhReviewMap = JSON.parse(fs.readFileSync(ZH_REVIEW_PATH, 'utf8'));
  const boardsData = JSON.parse(fs.readFileSync(BOARDS_PATH, 'utf8'));
  const overrideDoc = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
  const overrides = overrideDoc.overrides || {};

  if (mulberryList.length !== 3436) {
    throw new Error(`Expected 3436 mulberry entries, got ${mulberryList.length}`);
  }

  const boardMountedSet = new Set();
  const advancedBoards = boardsData && boardsData.advanced ? boardsData.advanced : [];
  for (const board of advancedBoards) {
    for (const tile of board.tiles || []) {
      const img = String(tile.image || '');
      if (img.includes('/symbols/mulberry/')) {
        boardMountedSet.add(path.basename(img));
      }
    }
  }

  // First pass: metadata, stem collisions, zh collisions
  const seenIds = new Set();
  const stemDomains = new Map();
  const zhGroups = new Map();
  const prelim = [];

  for (const item of mulberryList) {
    const file = path.basename(item.src);
    const symbolId = item.id;
    const domain = symbolId.includes('.') ? symbolId.split('.')[1] : 'general';
    const partId = makePartId(file, seenIds);
    const en = String(enMap[symbolId] || '').trim();
    const zhRaw = String(zhReviewMap[symbolId] || zhMap[symbolId] || '').trim();
    const ov = overrides[file] || null;
    const zh = ov ? String(ov.zh).trim() : zhRaw;
    const synonymsZh = ov && Array.isArray(ov.synonymsZh) ? ov.synonymsZh : [];
    const excludeQueries = ov && Array.isArray(ov.excludeQueries) ? ov.excludeQueries : [];
    const inDefaultBoards = boardMountedSet.has(file);
    const inAacReview = Object.prototype.hasOwnProperty.call(zhReviewMap, symbolId);
    const hasOverride = Boolean(ov);
    const partRole = (ov && ov.partRoleOverride) || inferPartRole(symbolId, domain, file, en, zh);

    const stem = path.basename(file, '.svg').replace(/(_,_to|_[0-9]+[a-z]?)$/i, '');
    if (!stemDomains.has(stem)) stemDomains.set(stem, new Set());
    stemDomains.get(stem).add(domain);

    if (zh) {
      if (!zhGroups.has(zh)) zhGroups.set(zh, []);
      zhGroups.get(zh).push({ domain, lemma: normalizeLemmaEn(en), file });
    }

    prelim.push({
      partId,
      file,
      symbolId,
      domain,
      src: item.src,
      en,
      zh,
      zhRaw,
      synonymsZh,
      excludeQueries,
      partRole,
      inDefaultBoards,
      inAacReview,
      hasOverride,
      stem
    });
  }

  const collidingZhSet = new Set();
  for (const [zhText, rows] of zhGroups.entries()) {
    const doms = new Set(rows.map(r => r.domain));
    const lemmas = new Set(rows.map(r => r.lemma));
    if (doms.size > 1 && lemmas.size > 1) {
      collidingZhSet.add(zhText);
    }
  }

  for (const p of prelim) {
    const stemDomainCount = stemDomains.get(p.stem).size;
    p.homographStem = stemDomainCount > 1 ? p.stem : null;

    const suspectReasons = [];
    if (!p.hasOverride) {
      if (!p.zh) {
        suspectReasons.push('empty_zh');
      } else if (
        p.domain !== 'alphabet' &&
        !(p.domain === 'number' && /^\d+$/.test(p.zh)) &&
        /^[A-Za-z0-9\s\-_.,/()&'+]+$/.test(p.zh)
      ) {
        suspectReasons.push('untranslated_ascii');
      }
      if (!p.inAacReview && p.zh && collidingZhSet.has(p.zh)) {
        suspectReasons.push('cross_domain_zh_collision');
      }
      // Flag obvious verb translated as a static sign/banner/picture noun (only when unreviewed)
      if (
        !p.inAacReview &&
        (p.file.endsWith('_,_to.svg') || p.en.toLowerCase().startsWith('to ')) &&
        /(闪光灯|标志|图标|海报)$/.test(p.zh)
      ) {
        suspectReasons.push('verb_mistranslated_as_noun');
      }
    }

    p.suspectReasons = suspectReasons;
    if (suspectReasons.length > 0) {
      p.trustTier = 'crowdin_suspect';
      p.autoComposeAllowed = false;
    } else if (p.hasOverride || p.inAacReview) {
      p.trustTier = 'trusted_curated';
      p.autoComposeAllowed = true;
    } else if (p.inDefaultBoards) {
      p.trustTier = 'board_mounted';
      p.autoComposeAllowed = true;
    } else {
      p.trustTier = 'crowdin_unreviewed';
      p.autoComposeAllowed = true;
    }
  }

  // Concurrent SVGO + sharp trim processing
  const ctx = { trimFailures: [], svgoErrors: [] };
  const results = new Array(prelim.length);
  let cursor = 0;
  const CONCURRENCY = 16;

  async function worker() {
    while (cursor < prelim.length) {
      const idx = cursor;
      cursor += 1;
      try {
        results[idx] = await processOneSvg(prelim[idx], ctx);
      } catch (err) {
        ctx.svgoErrors.push({ file: prelim[idx].file, error: String(err && err.message ? err.message : err) });
        throw err;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const parts = results.map(r => r.partRecord);
  const svgMap = {};
  for (let i = 0; i < results.length; i += 1) {
    svgMap[parts[i].partId] = results[i].finalSvg;
  }

  const svgsJson = JSON.stringify(svgMap);
  const svgsGz = zlib.gzipSync(Buffer.from(svgsJson, 'utf8'), { level: 9 });
  fs.writeFileSync(OUT_SVGS_GZ_PATH, svgsGz);

  const stats = {
    totalParts: parts.length,
    inDefaultBoardsCount: parts.filter(p => p.inDefaultBoards).length,
    dormantUnmountedCount: parts.filter(p => !p.inDefaultBoards).length,
    overriddenCount: parts.filter(p => p.hasOverride).length,
    aacReviewCount: parts.filter(p => p.inAacReview).length,
    trustedCuratedCount: parts.filter(p => p.trustTier === 'trusted_curated').length,
    boardMountedCount: parts.filter(p => p.trustTier === 'board_mounted').length,
    crowdinUnreviewedCount: parts.filter(p => p.trustTier === 'crowdin_unreviewed').length,
    crowdinSuspectCount: parts.filter(p => p.trustTier === 'crowdin_suspect').length,
    styleTagCount: parts.filter(p => p.hasStyleTag).length,
    defsIdCount: parts.filter(p => p.hasDefsId).length,
    nonStdViewBoxCount: parts.filter(p => p.isNonStdVb).length,
    nonSquareViewBoxCount: parts.filter(p => p.isNonSquareVb).length,
    trimFallbackCount: parts.filter(p => p.trimFallback).length,
    dotStRemainingCount: parts.filter(p => p.hasDotStRemaining).length,
    classAttrRemainingCount: parts.filter(p => p.hasClassRemaining).length,
    homographStemGroupCount: Array.from(stemDomains.values()).filter(s => s.size > 1).length,
    rawTotalBytes: parts.reduce((acc, p) => acc + p.rawBytes, 0),
    cleanTotalBytes: parts.reduce((acc, p) => acc + p.cleanBytes, 0),
    cleanGzipBytes: svgsGz.length,
    elapsedMs: Date.now() - t0
  };

  const indexDoc = {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    overridesVersion: overrideDoc.version,
    license: 'CC BY-SA 2.0',
    attribution: 'Mulberry Symbols (https://mulberrysymbols.org), CC BY-SA 2.0',
    sourceCount: parts.length,
    stats,
    parts
  };

  fs.writeFileSync(OUT_INDEX_PATH, JSON.stringify(indexDoc, null, 2) + '\n', 'utf8');

  if (auditDir) {
    fs.mkdirSync(auditDir, { recursive: true });
    const homographGroups = {};
    for (const p of parts) {
      if (p.homographStem) {
        if (!homographGroups[p.homographStem]) homographGroups[p.homographStem] = [];
        homographGroups[p.homographStem].push({
          file: p.file,
          domain: p.domain,
          en: p.en,
          zh: p.zh,
          trustTier: p.trustTier
        });
      }
    }

    const suspectParts = parts
      .filter(p => p.trustTier === 'crowdin_suspect')
      .map(p => ({
        partId: p.partId,
        file: p.file,
        domain: p.domain,
        en: p.en,
        zh: p.zh,
        inDefaultBoards: p.inDefaultBoards,
        suspectReasons: p.suspectReasons
      }));

    const nonSquareParts = parts
      .filter(p => p.isNonSquareVb)
      .map(p => ({
        file: p.file,
        origViewBox: p.origViewBox,
        tightViewBox: p.tightViewBox,
        contentRatio: p.contentRatio,
        trimFallback: p.trimFallback
      }));

    const overriddenList = parts
      .filter(p => p.hasOverride)
      .map(p => ({
        file: p.file,
        domain: p.domain,
        en: p.en,
        zhRaw: p.zhRaw,
        zhFixed: p.zh,
        synonymsZh: p.synonymsZh,
        excludeQueries: p.excludeQueries,
        partRole: p.partRole
      }));

    const auditReport = {
      stats,
      svgoErrors: ctx.svgoErrors,
      trimFailures: ctx.trimFailures,
      overriddenList,
      homographGroups,
      suspectParts,
      nonSquareParts
    };
    fs.writeFileSync(
      path.join(auditDir, 'audit_report.json'),
      JSON.stringify(auditReport, null, 2) + '\n',
      'utf8'
    );

    const mdLines = [
      '# Mulberry 3,436 原生 SVG Step 1 清洗与语义审计报告',
      '',
      `- 构建时间：${indexDoc.generatedAt}`,
      `- 版权协议：\`${indexDoc.license}\``,
      `- 总数：\`${stats.totalParts}\`（默认板已挂载 \`${stats.inDefaultBoardsCount}\`，新唤醒沉睡图符 \`${stats.dormantUnmountedCount}\`）`,
      `- SVG 清洗：含 \`<style>\` 原图 \`${stats.styleTagCount}\`，含 \`id=\` 原图 \`${stats.defsIdCount}\`，清洗后残留 \`.st*\` 数 \`${stats.dotStRemainingCount}\`，残留 \`class=\` 数 \`${stats.classAttrRemainingCount}\``,
      `- 紧致 \`viewBox\`：非标准 \`viewBox\` \`${stats.nonStdViewBoxCount}\`，非正方形 \`${stats.nonSquareViewBoxCount}\`，\`trimFallback\` 数 \`${stats.trimFallbackCount}\``,
      `- 体积统计：原始 \`${(stats.rawTotalBytes / 1024 / 1024).toFixed(2)} MB\` → 清洗 \`${(stats.cleanTotalBytes / 1024 / 1024).toFixed(2)} MB\` → \`.json.gz\` \`${(stats.cleanGzipBytes / 1024 / 1024).toFixed(2)} MB\`（耗时 \`${stats.elapsedMs} ms\`）`,
      `- 可信分级：\`trusted_curated=${stats.trustedCuratedCount}\` | \`board_mounted=${stats.boardMountedCount}\` | \`crowdin_unreviewed=${stats.crowdinUnreviewedCount}\` | \`crowdin_suspect=${stats.crowdinSuspectCount}\``,
      '',
      '## 一、已人工核实并纠偏的高危同形词与 Crowdin 错译（共 ' + overriddenList.length + ' 项）',
      '',
      '| 文件 | 领域 | 英文 | 原 zh-CN | 修复后 zh | 拦截词 (excludeQueries) |',
      '| :--- | :--- | :--- | :--- | :--- | :--- |',
      ...overriddenList
        .filter(x => x.zhRaw !== x.zhFixed || x.excludeQueries.length > 0)
        .map(x => `| \`${x.file}\` | ${x.domain} | ${x.en} | ${x.zhRaw} | **${x.zhFixed}** | ${x.excludeQueries.join(', ') || '—'} |`),
      '',
      '## 二、23 张非正方形 / 非原点 viewBox 紧致裁剪对照',
      '',
      '| 文件 | 原 viewBox | 紧致 viewBox | 有效面积比 | trimFallback |',
      '| :--- | :--- | :--- | ---: | :---: |',
      ...nonSquareParts.map(x => `| \`${x.file}\` | \`${x.origViewBox.join(' ')}\` | \`${x.tightViewBox.join(' ')}\` | ${x.contentRatio} | ${x.trimFallback} |`),
      '',
      '## 三、未覆盖但标为 `crowdin_suspect` (`autoComposeAllowed: false`) 汇总（共 ' + suspectParts.length + ' 项）',
      '',
      '| 文件 | 领域 | 英文 | 当前 zh | 默认板 | 疑因 |',
      '| :--- | :--- | :--- | :--- | :---: | :--- |',
      ...suspectParts.map(x => `| \`${x.file}\` | ${x.domain} | ${x.en} | ${x.zh || '(空)'} | ${x.inDefaultBoards} | \`${x.suspectReasons.join(',')}\` |`),
      ''
    ];
    fs.writeFileSync(path.join(auditDir, 'SUSPECT_TRANSLATION_AUDIT.md'), mdLines.join('\n'), 'utf8');
  }

  console.log('BUILD_MULBERRY_STEP1_DONE:', JSON.stringify(stats));
}

main().catch(err => {
  console.error('BUILD_MULBERRY_STEP1_FAILED:', err);
  process.exit(1);
});

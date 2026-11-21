'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = path.resolve(__dirname, '../data');
const INDEX_PATH = path.join(DATA_DIR, 'mulberrySymbolPartIndex.json');
const SVGS_GZ_PATH = path.join(DATA_DIR, 'mulberryCleanSvgs.json.gz');
const BGE_BIN_PATH = path.join(DATA_DIR, 'mulberrySymbolPartBgeInt8.bin');
const BGE_META_PATH = path.join(DATA_DIR, 'mulberrySymbolPartBgeMeta.json');

const TRUST_WEIGHT = Object.freeze({
  trusted_curated: 35,
  board_mounted: 15,
  crowdin_unreviewed: 0,
  crowdin_suspect: -1000
});

const TIER_PRIORITY = Object.freeze({
  trusted_curated: 3,
  board_mounted: 2,
  crowdin_unreviewed: 1,
  crowdin_suspect: 0
});

const SAFE_SINGLE_CHAR_DECOMPOSE = new Set(['伞', '雨', '吃', '喝', '药']);
const MODIFIER_COMPOSABLE_RE = /^(打|戴|用|拿|找|换|加|放|收|开|关|盒|箱|袋|套|架|折叠|便携|家用|电动)$/;
const REGEN_REQUIRED_RE = /(试纸|血糖|采血针|耳塞|手环|探头|传感器|导管|心电)/;

let cachedIndexState = null;
let cachedSvgMap = null;
let cachedBgeState = null;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim();
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildIndexState() {
  if (cachedIndexState) return cachedIndexState;

  const doc = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  const parts = Array.isArray(doc.parts) ? doc.parts : [];

  const byPartId = new Map();
  const byFile = new Map();
  const bySymbolId = new Map();
  const decomposeTermsMap = new Map();

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    byPartId.set(part.partId, part);
    byFile.set(part.file, part);
    if (!bySymbolId.has(part.symbolId)) {
      bySymbolId.set(part.symbolId, part);
    }

    if (part.autoComposeAllowed) {
      const terms = [
        ...(part.zh ? [{ term: part.zh, isPrimary: true }] : []),
        ...(Array.isArray(part.synonymsZh)
          ? part.synonymsZh.map(t => ({ term: t, isPrimary: false }))
          : [])
      ];
      for (const { term, isPrimary } of terms) {
        const cleanTerm = normalizeText(term);
        if (!cleanTerm) continue;
        if (cleanTerm.length < 2 && !SAFE_SINGLE_CHAR_DECOMPOSE.has(cleanTerm)) {
          continue;
        }
        if (!decomposeTermsMap.has(cleanTerm)) {
          decomposeTermsMap.set(cleanTerm, []);
        }
        decomposeTermsMap.get(cleanTerm).push({
          term: cleanTerm,
          part,
          rankScore:
            (isPrimary ? 100 : 80) +
            (TIER_PRIORITY[part.trustTier] || 0) * 20 +
            (part.hasOverride ? 15 : 0) +
            (part.inDefaultBoards ? 10 : 0)
        });
      }
    }
  }

  for (const list of decomposeTermsMap.values()) {
    list.sort((a, b) => b.rankScore - a.rankScore || a.part.partId.localeCompare(b.part.partId));
  }

  const decomposeKeysDesc = Array.from(decomposeTermsMap.keys()).sort(
    (a, b) => b.length - a.length || a.localeCompare(b)
  );

  cachedIndexState = {
    doc,
    parts,
    byPartId,
    byFile,
    bySymbolId,
    decomposeTermsMap,
    decomposeKeysDesc
  };
  return cachedIndexState;
}

function loadMulberryPartIndex() {
  return buildIndexState().doc;
}

function getMulberryPart(idOrFile) {
  const key = normalizeText(idOrFile);
  if (!key) return null;
  const state = buildIndexState();
  if (state.byPartId.has(key)) return state.byPartId.get(key);
  if (state.byFile.has(key)) return state.byFile.get(key);
  if (state.bySymbolId.has(key)) return state.bySymbolId.get(key);
  const baseNoExt = key.endsWith('.svg') ? key.slice(0, -4) : key;
  if (state.byPartId.has(baseNoExt)) return state.byPartId.get(baseNoExt);
  return null;
}

function loadSvgMap() {
  if (cachedSvgMap) return cachedSvgMap;
  const gzBuf = fs.readFileSync(SVGS_GZ_PATH);
  const jsonText = zlib.gunzipSync(gzBuf).toString('utf8');
  cachedSvgMap = JSON.parse(jsonText);
  return cachedSvgMap;
}

function loadCleanMulberrySvg(idOrFile, options = {}) {
  const part = getMulberryPart(idOrFile);
  if (!part) return null;
  const svgMap = loadSvgMap();
  const rawSvg = svgMap[part.partId];
  if (!rawSvg) return null;

  const instancePrefix = normalizeText(options.instancePrefix || '');
  if (!instancePrefix) return rawSvg;

  const safeInstance = instancePrefix.replace(/[^a-zA-Z0-9_-]/g, '_');
  const origPrefix = `mp_${part.partId}`;
  const nextPrefix = `${safeInstance}_${part.partId}`;
  const doubleRe = new RegExp(`${escapeRegExp(origPrefix)}__`, 'g');
  let renamed = rawSvg.replace(doubleRe, `${nextPrefix}__`);
  const exactRe = new RegExp(`([#"'])${escapeRegExp(origPrefix)}(?=["'#])`, 'g');
  renamed = renamed.replace(exactRe, `$1${nextPrefix}`);
  return renamed;
}

function isExcludedForQuery(part, queryNorm) {
  if (!queryNorm) return false;
  const lowQuery = queryNorm.toLowerCase();

  // Hard guard against boxing icon being selected as a storage box container
  if (part.file === 'box_,_to.svg' && /(盒|箱|匣|\bbox\b)/i.test(lowQuery)) {
    return true;
  }

  const excludes = Array.isArray(part.excludeQueries) ? part.excludeQueries : [];
  for (const exRaw of excludes) {
    const ex = normalizeText(exRaw).toLowerCase();
    if (!ex) continue;
    if (/^[a-z0-9\s]+$/.test(ex)) {
      const re = new RegExp(`\\b${escapeRegExp(ex)}\\b`, 'i');
      if (re.test(lowQuery)) return true;
    } else if (lowQuery === ex || lowQuery.includes(ex)) {
      return true;
    }
  }
  return false;
}

function loadBgeState() {
  if (cachedBgeState) return cachedBgeState;
  const meta = JSON.parse(fs.readFileSync(BGE_META_PATH, 'utf8'));
  const bin = fs.readFileSync(BGE_BIN_PATH);
  const { parts, byPartId } = buildIndexState();
  const metaParts = meta.partIds.map(pid => byPartId.get(pid) || null);
  cachedBgeState = { meta, bin, scales: meta.scales, metaParts, expectedCount: parts.length };
  return cachedBgeState;
}

function normalizeQueryVector(queryVector, dim) {
  if (!queryVector || typeof queryVector.length !== 'number' || queryVector.length !== dim) {
    throw new Error(`Expected queryVector of length ${dim}`);
  }
  const vec = new Float32Array(dim);
  let sumSq = 0;
  for (let i = 0; i < dim; i += 1) {
    const v = Number(queryVector[i]);
    if (!Number.isFinite(v)) throw new Error(`Invalid vector component at index ${i}`);
    vec[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0 && Math.abs(norm - 1) > 1e-4) {
    for (let i = 0; i < dim; i += 1) {
      vec[i] /= norm;
    }
  }
  return vec;
}

function computeAllBgeScores(queryVector) {
  const bge = loadBgeState();
  const { meta, bin, scales, metaParts } = bge;
  const { count, dim, partIds } = meta;
  const qv = normalizeQueryVector(queryVector, dim);
  const scores = new Map();

  for (let row = 0; row < count; row += 1) {
    const part = metaParts[row];
    if (!part) continue;
    const offset = row * dim;
    let dot = 0;
    for (let d = 0; d < dim; d += 1) {
      dot += bin.readInt8(offset + d) * qv[d];
    }
    scores.set(partIds[row], dot * scales[row]);
  }
  return scores;
}

function scoreBgeInt8TopK(queryVector, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 8;
  const allowSuspect = Boolean(options.allowSuspect);
  const role = options.role || null;
  const excludeRoles = new Set(Array.isArray(options.excludeRoles) ? options.excludeRoles : []);
  const excludeQuery = normalizeText(options.excludeQuery || '');

  const bge = loadBgeState();
  const { meta, bin, scales, metaParts } = bge;
  const { count, dim } = meta;
  const qv = normalizeQueryVector(queryVector, dim);

  const scored = [];
  for (let row = 0; row < count; row += 1) {
    const part = metaParts[row];
    if (!part) continue;
    if (!allowSuspect && !part.autoComposeAllowed) continue;
    if (role && part.partRole !== role) continue;
    if (excludeRoles.has(part.partRole)) continue;
    if (excludeQuery && isExcludedForQuery(part, excludeQuery)) continue;

    const offset = row * dim;
    let dot = 0;
    for (let d = 0; d < dim; d += 1) {
      dot += bin.readInt8(offset + d) * qv[d];
    }
    const cosine = dot * scales[row];
    scored.push({
      partId: part.partId,
      file: part.file,
      symbolId: part.symbolId,
      zh: part.zh,
      en: part.en,
      domain: part.domain,
      partRole: part.partRole,
      trustTier: part.trustTier,
      inDefaultBoards: part.inDefaultBoards,
      tightViewBox: part.tightViewBox,
      cosine: +cosine.toFixed(6)
    });
  }

  scored.sort((a, b) => b.cosine - a.cosine || a.partId.localeCompare(b.partId));
  return scored.slice(0, limit);
}

function scoreLexicalCandidate(part, queryNorm, lowQuery) {
  let bestScore = 0;
  let matchReason = null;

  const zh = normalizeText(part.zh);
  const lowEn = normalizeText(part.en).toLowerCase();
  const syns = Array.isArray(part.synonymsZh) ? part.synonymsZh.map(normalizeText).filter(Boolean) : [];

  if (zh && zh === queryNorm) {
    return { score: 1000, matchReason: 'exact_zh' };
  }
  for (const syn of syns) {
    if (syn === queryNorm) {
      return { score: 920, matchReason: 'exact_synonym_zh' };
    }
  }
  if (lowEn && lowEn === lowQuery) {
    return { score: 880, matchReason: 'exact_en' };
  }

  // Subword / compound hit: query contains a >=2 char term (e.g. 轮椅坐垫 -> 轮椅, 坐垫)
  if (zh && zh.length >= 2 && queryNorm.includes(zh)) {
    const s = 720 + zh.length * 15;
    if (s > bestScore) {
      bestScore = s;
      matchReason = 'subword_zh';
    }
  }
  for (const syn of syns) {
    if (syn.length >= 2 && queryNorm.includes(syn)) {
      const s = 720 + syn.length * 15;
      if (s > bestScore) {
        bestScore = s;
        matchReason = 'subword_synonym_zh';
      }
    } else if (
      syn.length === 1 &&
      queryNorm.length >= 2 &&
      SAFE_SINGLE_CHAR_DECOMPOSE.has(syn) &&
      queryNorm.includes(syn)
    ) {
      const s = 640;
      if (s > bestScore) {
        bestScore = s;
        matchReason = 'subword_single_synonym';
      }
    }
  }

  // Superstring hit: part term contains >=2 char query
  if (queryNorm.length >= 2) {
    if (zh && zh.includes(queryNorm)) {
      const s = Math.max(200, 500 - (zh.length - queryNorm.length) * 8);
      if (s > bestScore) {
        bestScore = s;
        matchReason = 'contains_zh';
      }
    }
    for (const syn of syns) {
      if (syn.includes(queryNorm)) {
        const s = Math.max(180, 470 - (syn.length - queryNorm.length) * 8);
        if (s > bestScore) {
          bestScore = s;
          matchReason = 'contains_synonym_zh';
        }
      }
    }
  }

  // English token match when ASCII query
  if (/^[a-z0-9\s_-]+$/i.test(lowQuery) && lowQuery.length >= 2 && lowEn) {
    const enTokens = lowEn.split(/\s+/);
    if (enTokens.includes(lowQuery)) {
      const s = 540;
      if (s > bestScore) {
        bestScore = s;
        matchReason = 'en_token';
      }
    }
  }

  return { score: bestScore, matchReason };
}

function searchMulberryParts(query, options = {}) {
  const queryNorm = normalizeText(query);
  const lowQuery = queryNorm.toLowerCase();
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 8;
  const role = options.role || null;
  const excludeRoles = new Set(Array.isArray(options.excludeRoles) ? options.excludeRoles : []);
  const allowSuspect = Boolean(options.allowSuspect);
  const preferredDomains = new Set(Array.isArray(options.preferredDomains) ? options.preferredDomains : []);

  const state = buildIndexState();
  const bgeScores = options.queryVector ? computeAllBgeScores(options.queryVector) : null;

  if (!queryNorm && !bgeScores) {
    return { query: queryNorm, totalIndexed: state.parts.length, candidates: [] };
  }

  const results = [];
  for (const part of state.parts) {
    if (!allowSuspect && !part.autoComposeAllowed) continue;
    if (role && part.partRole !== role) continue;
    if (excludeRoles.has(part.partRole)) continue;
    if (queryNorm && isExcludedForQuery(part, queryNorm)) continue;

    const lex = queryNorm ? scoreLexicalCandidate(part, queryNorm, lowQuery) : { score: 0, matchReason: null };
    const bgeSim = bgeScores ? (bgeScores.get(part.partId) || 0) : 0;

    if (lex.score <= 0 && !(bgeScores && bgeSim > 0.35)) continue;

    let totalScore = lex.score;
    totalScore += TRUST_WEIGHT[part.trustTier] || 0;
    if (preferredDomains.has(part.domain)) totalScore += 25;
    if (bgeScores) totalScore += bgeSim * 220;

    results.push({
      partId: part.partId,
      file: part.file,
      symbolId: part.symbolId,
      zh: part.zh,
      en: part.en,
      domain: part.domain,
      partRole: part.partRole,
      trustTier: part.trustTier,
      autoComposeAllowed: part.autoComposeAllowed,
      inDefaultBoards: part.inDefaultBoards,
      tightViewBox: part.tightViewBox,
      score: +totalScore.toFixed(3),
      bgeCosine: bgeScores ? +bgeSim.toFixed(4) : null,
      matchReason: lex.matchReason || 'bge_semantic'
    });
  }

  results.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.inDefaultBoards) - Number(a.inDefaultBoards) ||
      (TIER_PRIORITY[b.trustTier] || 0) - (TIER_PRIORITY[a.trustTier] || 0) ||
      a.partId.localeCompare(b.partId)
  );

  return {
    query: queryNorm,
    totalIndexed: state.parts.length,
    candidates: results.slice(0, limit)
  };
}

function decomposeConceptToMulberryParts(phrase, options = {}) {
  const cleanPhrase = normalizeText(phrase);
  const state = buildIndexState();
  const matchedParts = [];
  const unmatchedSpans = [];
  const seenPartIds = new Set();

  if (!cleanPhrase) {
    return {
      phrase: cleanPhrase,
      matchedParts,
      unmatchedSpans,
      recommendedTier: 'regen_from_ref'
    };
  }

  let cursor = 0;
  let pendingUnmatched = '';

  const flushUnmatched = () => {
    if (pendingUnmatched) {
      unmatchedSpans.push(pendingUnmatched);
      pendingUnmatched = '';
    }
  };

  while (cursor < cleanPhrase.length) {
    let bestHit = null;
    for (const term of state.decomposeKeysDesc) {
      if (term.length > cleanPhrase.length - cursor) continue;
      if (cleanPhrase.startsWith(term, cursor)) {
        const candidates = state.decomposeTermsMap.get(term) || [];
        const chosen = candidates.find(c => !isExcludedForQuery(c.part, cleanPhrase));
        if (chosen) {
          bestHit = { term, part: chosen.part };
          break;
        }
      }
    }

    if (bestHit) {
      flushUnmatched();
      if (!seenPartIds.has(bestHit.part.partId)) {
        seenPartIds.add(bestHit.part.partId);
        matchedParts.push({
          matchedTerm: bestHit.term,
          partId: bestHit.part.partId,
          file: bestHit.part.file,
          zh: bestHit.part.zh,
          en: bestHit.part.en,
          partRole: bestHit.part.partRole,
          trustTier: bestHit.part.trustTier,
          tightViewBox: bestHit.part.tightViewBox
        });
      }
      cursor += bestHit.term.length;
    } else {
      pendingUnmatched += cleanPhrase[cursor];
      cursor += 1;
    }
  }
  flushUnmatched();

  let recommendedTier = 'regen_from_ref';
  const hasRegenMissing = unmatchedSpans.some(s => REGEN_REQUIRED_RE.test(s));
  if (matchedParts.length === 0 || hasRegenMissing) {
    recommendedTier = 'regen_from_ref';
  } else if (unmatchedSpans.length === 0) {
    recommendedTier = 'compose_ready';
  } else if (
    unmatchedSpans.every(s => MODIFIER_COMPOSABLE_RE.test(s) || s.length === 1)
  ) {
    recommendedTier = 'compose_with_modifier';
  } else {
    recommendedTier = 'regen_from_ref';
  }

  return {
    phrase: cleanPhrase,
    matchedParts,
    unmatchedSpans,
    recommendedTier
  };
}

module.exports = {
  loadMulberryPartIndex,
  getMulberryPart,
  loadCleanMulberrySvg,
  searchMulberryParts,
  decomposeConceptToMulberryParts,
  scoreBgeInt8TopK
};

'use strict';

const sharp = require('sharp');

const DEFAULT_VECTOR_GRID = 96;
const MAX_SVG_BYTES = 96 * 1024;
const OUTPUT_VIEWBOX = 300;
const INK_HEX = '#1E1E1E';
const BACKGROUND_HEX = '#FFFFFF';

const UNSAFE_SVG_PATTERNS = [
  /<script\b/i,
  /<\/script>/i,
  /\bon[a-z]+\s*=/i,
  /javascript\s*:/i,
  /<foreignObject\b/i,
  /<iframe\b/i,
  /<object\b/i,
  /<embed\b/i,
  /(?:xlink:)?href\s*=\s*["']\s*https?:/i
];

function createVectorizerError(message, status = 400, code = 'VECTORIZER_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function assertSafeVectorSvg(svgText, { maxBytes = MAX_SVG_BYTES } = {}) {
  if (typeof svgText !== 'string' || !svgText.trim()) {
    throw createVectorizerError(
      'Vectorized output must be a non-empty SVG string',
      502,
      'INVALID_VECTORIZED_SVG'
    );
  }
  const normalized = svgText.trim();
  if (!/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b[\s\S]*<\/svg>\s*$/i.test(normalized)) {
    throw createVectorizerError(
      'Vectorized output must be a single valid <svg> document',
      502,
      'INVALID_VECTORIZED_SVG'
    );
  }
  for (const pattern of UNSAFE_SVG_PATTERNS) {
    if (pattern.test(normalized)) {
      throw createVectorizerError(
        `Vectorized SVG contains disallowed construct (${pattern.source})`,
        502,
        'UNSAFE_VECTORIZED_SVG'
      );
    }
  }
  const bytes = Buffer.byteLength(normalized, 'utf8');
  if (bytes > maxBytes) {
    throw createVectorizerError(
      `Vectorized SVG exceeds byte budget (${bytes} > ${maxBytes})`,
      502,
      'SVG_BYTE_BUDGET_EXCEEDED'
    );
  }
  return normalized;
}

function tryLoadNeplexVectorizer(injectedModule = null) {
  if (injectedModule) return injectedModule;
  try {
    return require('@neplex/vectorizer');
  } catch (_) {
    return null;
  }
}

function rgbToHex(r, g, b) {
  const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
  return (
    '#' +
    [clamp(r), clamp(g), clamp(b)]
      .map(v => v.toString(16).toUpperCase().padStart(2, '0'))
      .join('')
  );
}

function colorDistanceSq(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

function despeckleLabels(labels, width, height) {
  const out = new Int16Array(labels);
  for (let y = 1; y < height - 1; y += 1) {
    const rowOffset = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const idx = rowOffset + x;
      const cur = labels[idx];
      const up = labels[idx - width];
      if (up !== cur && up === labels[idx + width] && up === labels[idx - 1] && up === labels[idx + 1]) {
        out[idx] = up;
      }
    }
  }
  return out;
}

function fmtCoord(v) {
  const rounded = Math.round(v * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

// Direction codes: 0 = East (+x), 1 = South (+y), 2 = West (-x), 3 = North (-y)
function pickNextEdge(outgoingList, prevDir) {
  if (outgoingList.length === 1) {
    return outgoingList.pop();
  }
  // Prefer turning right (+1 mod 4) to avoid pinching checkerboard diagonal tunnels
  const preferredOrder = [(prevDir + 1) & 3, prevDir, (prevDir + 3) & 3, (prevDir + 2) & 3];
  for (const dir of preferredOrder) {
    const idx = outgoingList.findIndex(e => e.dir === dir && !e.used);
    if (idx !== -1) {
      const [chosen] = outgoingList.splice(idx, 1);
      return chosen;
    }
  }
  return outgoingList.pop();
}

function simplifyColinearPolygon(pts) {
  const n = pts.length;
  if (n < 3) return pts;
  const simplified = [];
  for (let i = 0; i < n; i += 1) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;
    if (dx1 * dy2 - dy1 * dx2 !== 0) {
      simplified.push(curr);
    }
  }
  return simplified.length >= 3 ? simplified : pts;
}

function perpDistSq(pt, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return (pt.x - a.x) * (pt.x - a.x) + (pt.y - a.y) * (pt.y - a.y);
  }
  const t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq;
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  const ex = pt.x - projX;
  const ey = pt.y - projY;
  return ex * ex + ey * ey;
}

function rdpOpen(pts, epsilonSq) {
  if (pts.length <= 2) return pts;
  let maxDistSq = 0;
  let splitIdx = 0;
  const first = pts[0];
  const last = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const dSq = perpDistSq(pts[i], first, last);
    if (dSq > maxDistSq) {
      maxDistSq = dSq;
      splitIdx = i;
    }
  }
  if (maxDistSq <= epsilonSq) {
    return [first, last];
  }
  const left = rdpOpen(pts.slice(0, splitIdx + 1), epsilonSq);
  const right = rdpOpen(pts.slice(splitIdx), epsilonSq);
  return left.slice(0, -1).concat(right);
}

function simplifyClosedPolygonRdp(pts, epsilon = 0.65) {
  const n = pts.length;
  if (n < 4) return pts;
  // Find two farthest antipodal-like vertices to split the closed ring cleanly
  let idxA = 0;
  let idxB = Math.floor(n / 2);
  let bestSpan = -1;
  for (let i = 0; i < n; i += 1) {
    const dx = pts[i].x - pts[0].x;
    const dy = pts[i].y - pts[0].y;
    const d = dx * dx + dy * dy;
    if (d > bestSpan) {
      bestSpan = d;
      idxB = i;
    }
  }
  const epsSq = epsilon * epsilon;
  const half1 = rdpOpen(pts.slice(idxA, idxB + 1), epsSq);
  const half2 = rdpOpen(pts.slice(idxB).concat([pts[idxA]]), epsSq);
  const merged = half1.slice(0, -1).concat(half2.slice(0, -1));
  return merged.length >= 3 ? merged : pts;
}

function loopToSmoothSvgSubpath(rawPts) {
  const colinearReduced = simplifyColinearPolygon(rawPts);
  const pts = colinearReduced.length >= 6 ? simplifyClosedPolygonRdp(colinearReduced, 0.55) : colinearReduced;
  const n = pts.length;
  if (n < 3) return '';

  const commands = [];
  for (let i = 0; i < n; i += 1) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];

    const vInX = prev.x - curr.x;
    const vInY = prev.y - curr.y;
    const lenIn = Math.hypot(vInX, vInY);

    const vOutX = next.x - curr.x;
    const vOutY = next.y - curr.y;
    const lenOut = Math.hypot(vOutX, vOutY);

    if (lenIn === 0 || lenOut === 0) continue;

    const radius = Math.min(lenIn * 0.45, lenOut * 0.45, 2.0);
    const sx = curr.x + (vInX / lenIn) * radius;
    const sy = curr.y + (vInY / lenIn) * radius;
    const ex = curr.x + (vOutX / lenOut) * radius;
    const ey = curr.y + (vOutY / lenOut) * radius;

    if (commands.length === 0) {
      commands.push(`M${fmtCoord(sx)} ${fmtCoord(sy)}`);
    } else {
      commands.push(`L${fmtCoord(sx)} ${fmtCoord(sy)}`);
    }
    commands.push(`Q${fmtCoord(curr.x)} ${fmtCoord(curr.y)} ${fmtCoord(ex)} ${fmtCoord(ey)}`);
  }
  if (!commands.length) return '';
  commands.push('Z');
  return commands.join('');
}

function extractSmoothContourPath(labels, width, height, targetLabel) {
  const edgesByStart = new Map();
  const addEdge = (x0, y0, x1, y1, dir) => {
    const key = `${x0},${y0}`;
    let list = edgesByStart.get(key);
    if (!list) {
      list = [];
      edgesByStart.set(key, list);
    }
    list.push({ x0, y0, x1, y1, dir, used: false });
  };

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x += 1) {
      if (labels[rowOffset + x] !== targetLabel) continue;
      if (y === 0 || labels[rowOffset - width + x] !== targetLabel) addEdge(x, y, x + 1, y, 0);
      if (x === width - 1 || labels[rowOffset + x + 1] !== targetLabel) addEdge(x + 1, y, x + 1, y + 1, 1);
      if (y === height - 1 || labels[rowOffset + width + x] !== targetLabel) addEdge(x + 1, y + 1, x, y + 1, 2);
      if (x === 0 || labels[rowOffset + x - 1] !== targetLabel) addEdge(x, y + 1, x, y, 3);
    }
  }

  if (edgesByStart.size === 0) {
    return { pathData: '', loopCount: 0, edgeCount: 0 };
  }

  const subpaths = [];
  let totalEdges = 0;

  for (const [, startList] of edgesByStart.entries()) {
    while (startList.length > 0) {
      const first = startList.pop();
      if (!first || first.used) continue;
      first.used = true;
      totalEdges += 1;

      const pts = [{ x: first.x0, y: first.y0 }];
      let currX = first.x1;
      let currY = first.y1;
      let prevDir = first.dir;
      let guard = 0;

      while ((currX !== first.x0 || currY !== first.y0) && guard < width * height * 4) {
        guard += 1;
        pts.push({ x: currX, y: currY });
        const nextList = edgesByStart.get(`${currX},${currY}`);
        if (!nextList || nextList.length === 0) break;
        const nextEdge = pickNextEdge(nextList, prevDir);
        if (!nextEdge || nextEdge.used) break;
        nextEdge.used = true;
        totalEdges += 1;
        currX = nextEdge.x1;
        currY = nextEdge.y1;
        prevDir = nextEdge.dir;
      }

      if (pts.length >= 4) {
        const sub = loopToSmoothSvgSubpath(pts);
        if (sub) subpaths.push(sub);
      }
    }
  }

  return {
    pathData: subpaths.join(''),
    loopCount: subpaths.length,
    edgeCount: totalEdges
  };
}

async function tracePngToQuantizedSvg(
  pngBuffer,
  { gridSize = DEFAULT_VECTOR_GRID, maxColors = 10, viewBoxSize = OUTPUT_VIEWBOX } = {}
) {
  if (!Buffer.isBuffer(pngBuffer) || !pngBuffer.length) {
    throw createVectorizerError('pngBuffer must be a non-empty Buffer', 400, 'INVALID_PNG_BUFFER');
  }

  const boundedGrid = Math.max(24, Math.min(192, Number(gridSize) || DEFAULT_VECTOR_GRID));
  const boundedColors = Math.max(2, Math.min(24, Number(maxColors) || 10));
  const boundedViewBox = Math.max(64, Math.min(1024, Number(viewBoxSize) || OUTPUT_VIEWBOX));

  const { data, info } = await sharp(pngBuffer)
    .flatten({ background: '#ffffff' })
    .resize(boundedGrid, boundedGrid, {
      fit: 'contain',
      kernel: 'cubic',
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const totalPixels = width * height;
  const labels = new Int16Array(totalPixels);
  labels.fill(-1);

  const buckets = new Map();
  const nonInkIndices = [];

  for (let i = 0; i < totalPixels; i += 1) {
    const p = i * 4;
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const a = data[p + 3];

    if (a < 32) {
      labels[i] = -1;
      continue;
    }

    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const spread = maxC - minC;

    if ((r >= 244 && g >= 244 && b >= 244) || (minC >= 232 && spread <= 14)) {
      labels[i] = -1;
      continue;
    }

    if (r <= 118 && g <= 118 && b <= 118 && spread <= 28) {
      labels[i] = 0;
      continue;
    }

    const qr = Math.min(224, Math.round(r / 32) * 32);
    const qg = Math.min(224, Math.round(g / 32) * 32);
    const qb = Math.min(224, Math.round(b / 32) * 32);
    const key = `${qr},${qg},${qb}`;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { sumR: 0, sumG: 0, sumB: 0, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.sumR += r;
    bucket.sumG += g;
    bucket.sumB += b;
    bucket.count += 1;
    nonInkIndices.push({ index: i, r, g, b });
  }

  const rawCentroids = Array.from(buckets.values())
    .map(b => ({
      r: b.sumR / b.count,
      g: b.sumG / b.count,
      b: b.sumB / b.count,
      count: b.count
    }))
    .sort((a, b) => b.count - a.count);

  const palette = [];
  for (const cand of rawCentroids) {
    const nearExisting = palette.find(p => colorDistanceSq(p, cand) < 1296);
    if (nearExisting) {
      const nextCount = nearExisting.count + cand.count;
      nearExisting.r = (nearExisting.r * nearExisting.count + cand.r * cand.count) / nextCount;
      nearExisting.g = (nearExisting.g * nearExisting.count + cand.g * cand.count) / nextCount;
      nearExisting.b = (nearExisting.b * nearExisting.count + cand.b * cand.count) / nextCount;
      nearExisting.count = nextCount;
    } else if (palette.length < boundedColors - 1) {
      palette.push({ ...cand });
    }
  }

  for (const px of nonInkIndices) {
    if (!palette.length) {
      labels[px.index] = 0;
      continue;
    }
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let c = 0; c < palette.length; c += 1) {
      const d = colorDistanceSq(px, palette[c]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = c;
      }
    }
    labels[px.index] = bestIdx + 1;
  }

  const cleanedLabels = despeckleLabels(labels, width, height);

  const layers = [];
  let totalLoops = 0;

  for (let c = 0; c < palette.length; c += 1) {
    const colorIdx = c + 1;
    const { pathData, loopCount } = extractSmoothContourPath(cleanedLabels, width, height, colorIdx);
    if (pathData) {
      totalLoops += loopCount;
      layers.push({
        hex: rgbToHex(palette[c].r, palette[c].g, palette[c].b),
        pathData
      });
    }
  }

  // Emit dark ink outlines last so outlines stay sharp above solid fills
  const inkLayer = extractSmoothContourPath(cleanedLabels, width, height, 0);
  if (inkLayer.pathData) {
    totalLoops += inkLayer.loopCount;
    layers.push({
      hex: INK_HEX,
      pathData: inkLayer.pathData
    });
  }

  const pathElements = layers
    .map(layer => `<path fill="${layer.hex}" fill-rule="evenodd" d="${layer.pathData}"/>`)
    .join('');

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${boundedViewBox}" height="${boundedViewBox}">`,
    `<rect width="100%" height="100%" fill="${BACKGROUND_HEX}"/>`,
    pathElements,
    '</svg>'
  ].join('');

  return {
    svg,
    engine: 'builtin-smooth-contour',
    bytes: Buffer.byteLength(svg, 'utf8'),
    colorCount: layers.length,
    rectCount: totalLoops,
    loopCount: totalLoops,
    gridSize: width
  };
}

async function runNeplexVectorizer(neplexModule, pngBuffer, options = {}) {
  const vectorizeFn =
    typeof neplexModule.vectorize === 'function'
      ? neplexModule.vectorize
      : typeof neplexModule.default === 'function'
      ? neplexModule.default
      : null;

  if (!vectorizeFn) {
    throw createVectorizerError('Invalid @neplex/vectorizer module', 500, 'VECTORIZER_UNAVAILABLE');
  }

  const presetConfig = {
    colorMode: options.colorMode ?? 0,
    hierarchical: options.hierarchical ?? 0,
    filterSpeckle: options.filterSpeckle ?? 4,
    colorPrecision: options.colorPrecision ?? 5,
    layerDifference: options.layerDifference ?? 16,
    mode: options.mode ?? 2,
    cornerThreshold: options.cornerThreshold ?? 60,
    lengthThreshold: options.lengthThreshold ?? 4.0,
    maxIterations: options.maxIterations ?? 10,
    spliceThreshold: options.spliceThreshold ?? 45,
    pathPrecision: options.pathPrecision ?? 2
  };

  const rawSvg = await Promise.resolve(vectorizeFn(pngBuffer, presetConfig));
  const safeSvg = assertSafeVectorSvg(rawSvg, { maxBytes: options.maxBytes || MAX_SVG_BYTES });

  return {
    svg: safeSvg,
    engine: 'neplex-vtracer',
    bytes: Buffer.byteLength(safeSvg, 'utf8'),
    colorCount: null,
    rectCount: null,
    loopCount: null,
    gridSize: null
  };
}

async function vectorizePngToCleanSvg(pngBuffer, options = {}) {
  if (!Buffer.isBuffer(pngBuffer) || !pngBuffer.length) {
    throw createVectorizerError('pngBuffer must be a non-empty Buffer', 400, 'INVALID_PNG_BUFFER');
  }

  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_SVG_BYTES;
  const maxColors = options.maxColors || 10;
  const viewBoxSize = options.viewBoxSize || OUTPUT_VIEWBOX;

  const neplex =
    options.engine === 'builtin'
      ? null
      : tryLoadNeplexVectorizer(options.neplexModule || null);

  let traced;
  if (neplex) {
    traced = await runNeplexVectorizer(neplex, pngBuffer, { ...options, maxBytes });
  } else {
    const primaryGrid = options.gridSize || DEFAULT_VECTOR_GRID;
    traced = await tracePngToQuantizedSvg(pngBuffer, {
      gridSize: primaryGrid,
      maxColors,
      viewBoxSize
    });

    if (traced.bytes > maxBytes) {
      traced = await tracePngToQuantizedSvg(pngBuffer, {
        gridSize: Math.min(64, primaryGrid),
        maxColors: Math.min(8, maxColors),
        viewBoxSize
      });
    }
    traced.svg = assertSafeVectorSvg(traced.svg, { maxBytes });
    traced.bytes = Buffer.byteLength(traced.svg, 'utf8');
  }

  // Ensure librsvg / sharp can rasterize the emitted SVG cleanly
  await sharp(Buffer.from(traced.svg, 'utf8')).metadata();

  return traced;
}

function createPictogramVectorizer(defaultOptions = {}) {
  return async function vectorizePictogramPng(pngBuffer) {
    const res = await vectorizePngToCleanSvg(pngBuffer, defaultOptions);
    return res.svg;
  };
}

module.exports = {
  DEFAULT_VECTOR_GRID,
  MAX_SVG_BYTES,
  OUTPUT_VIEWBOX,
  assertSafeVectorSvg,
  createPictogramVectorizer,
  tracePngToQuantizedSvg,
  tryLoadNeplexVectorizer,
  vectorizePngToCleanSvg
};

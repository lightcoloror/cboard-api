'use strict';

const sharp = require('sharp');
const {
  decomposeConceptToMulberryParts,
  getMulberryPart,
  loadCleanMulberrySvg,
  searchMulberryParts
} = require('./mulberryPartIndex');
const { normalizePublicPictogramImage } = require('./pictogramImage');

const COMPOSER_CANVAS_SIZE = 300;
const MAX_COMPOSITION_LABEL_LENGTH = 24;
const DEFAULT_FRAME_DELAYS_MS = Object.freeze([500, 450, 500, 950]);
const MULBERRY_LICENSE = 'CC BY-SA 2.0';
const MULBERRY_ATTRIBUTION = 'Mulberry Symbols (https://mulberrysymbols.org), CC BY-SA 2.0';

const ALLOWED_RECIPE_OPS = Object.freeze([
  'single_part',
  'focus_part_of',
  'locate_on',
  'container_put',
  'link_flow',
  'act_with',
  'modify_attr',
  'negate_thought',
  'sequence_ab',
  'regen_only'
]);

const ALLOWED_MODIFIERS = Object.freeze([
  'hot',
  'cold',
  'up',
  'down',
  'open',
  'close',
  'find',
  'replace',
  'clean',
  'fold',
  'broken',
  'more',
  'less'
]);

const MODIFIER_PREFIX_RULES = Object.freeze([
  { re: /^(找|寻找)(.{1,6})$/, modifier: 'find' },
  { re: /^(换|更换)(.{1,6})$/, modifier: 'replace' },
  { re: /^(打开|开)(.{1,6})$/, modifier: 'open' },
  { re: /^(关闭|关上|关|拉上|拉)(.{1,6})$/, modifier: 'close' },
  { re: /^(调高|升高|开大)(.{1,6})$/, modifier: 'up' },
  { re: /^(调低|降低|关小)(.{1,6})$/, modifier: 'down' },
  { re: /^(热|温热|烧热)(.{1,6})$/, modifier: 'hot' },
  { re: /^(冷|冰)(.{1,6})$/, modifier: 'cold' },
  { re: /^(擦|洗|清理)(.{1,6})$/, modifier: 'clean' }
]);

const SHORTCUT_PART_IDS = Object.freeze({
  吃饭: 'rice',
  饭: 'rice',
  米饭: 'rice',
  吃药: 'tablets',
  药: 'tablets',
  药片: 'tablets',
  药丸: 'tablets',
  喝水: 'water',
  水: 'water',
  洗手: 'wash_hands_to',
  洗澡: 'bathe_to',
  睡觉: 'sleep_male_to',
  睡: 'sleep_male_to',
  助听器: 'hearing_aid_1',
  电池: 'battery_1a',
  轮椅: 'wheelchair',
  坐垫: 'cushion_2',
  眼镜: 'glasses',
  雨伞: 'umbrella',
  伞: 'umbrella',
  下雨: 'rain',
  手机: 'mobile_phone',
  充电器: 'electric_charger',
  手杖: 'walking_stick',
  拐杖: 'walking_stick',
  手指: 'finger',
  测血压: 'blood_pressure',
  吃: 'eat_1_to'
});

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeCompositionLabel(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_COMPOSITION_LABEL_LENGTH);
}

function stripOuterSvg(svgText) {
  return String(svgText || '')
    .replace(/^[\s\S]*?<svg\b[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '');
}

function embedCleanMulberryPart(partId, tx, ty, tw, th, options = {}) {
  const part = getMulberryPart(partId);
  if (!part) return '';
  const instancePrefix = options.instancePrefix || `p_${part.partId}`;
  const cleanSvg = loadCleanMulberrySvg(part.partId, { instancePrefix });
  if (!cleanSvg) return '';

  const inner = stripOuterSvg(cleanSvg);
  const [bx, by, bw, bh] = part.tightViewBox;
  const scale = Math.min(tw / Math.max(1, bw), th / Math.max(1, bh));
  const realW = bw * scale;
  const realH = bh * scale;
  const ox = tx + (tw - realW) / 2 - bx * scale;
  const oy = ty + (th - realH) / 2 - by * scale;
  const opacity =
    Number.isFinite(options.opacity) && options.opacity < 1
      ? ` opacity="${options.opacity}"`
      : '';
  const filter = options.grayscale ? ' filter="url(#gray)"' : '';

  return `<g${opacity}${filter} transform="translate(${ox.toFixed(2)}, ${oy.toFixed(2)}) scale(${scale.toFixed(5)})">${inner}</g>`;
}

function resolvePartForPhrase(phrase, options = {}) {
  const clean = sanitizeCompositionLabel(phrase);
  if (!clean) return null;

  if (Object.prototype.hasOwnProperty.call(SHORTCUT_PART_IDS, clean)) {
    const p = getMulberryPart(SHORTCUT_PART_IDS[clean]);
    if (p) return p;
  }

  const res = searchMulberryParts(clean, { limit: 6 });
  if (res.candidates && res.candidates.length > 0) {
    if (options.preferRole) {
      const roleMatch = res.candidates.find(c => c.partRole === options.preferRole);
      if (roleMatch && roleMatch.score >= res.candidates[0].score - 120) {
        return getMulberryPart(roleMatch.partId);
      }
    }
    return getMulberryPart(res.candidates[0].partId);
  }
  return null;
}

function summarizeSourceParts(partIds) {
  const seen = new Set();
  const list = [];
  for (const id of partIds) {
    if (!id || seen.has(id)) continue;
    const part = getMulberryPart(id);
    if (!part) continue;
    seen.add(id);
    list.push({
      partId: part.partId,
      file: part.file,
      symbolId: part.symbolId,
      zh: part.zh,
      en: part.en,
      domain: part.domain
    });
  }
  return list;
}

function buildCuratedExactRecipe(label) {
  switch (label) {
    case '助听器电池':
      return {
        label,
        ruleId: 'curated_hearing_aid_battery',
        mode: 'compose',
        op: 'focus_part_of',
        head: 'battery_1a',
        context: 'hearing_aid_1',
        motion: 'pulse_head',
        badgeText: '拼合示意',
        needsRegenFallback: false,
        referencePartId: 'battery_1a',
        regenHint: ''
      };
    case '轮椅坐垫':
      return {
        label,
        ruleId: 'curated_wheelchair_cushion',
        mode: 'compose',
        op: 'locate_on',
        head: 'cushion_2',
        context: 'wheelchair',
        motion: 'pulse_head',
        badgeText: '拼合示意',
        needsRegenFallback: false,
        referencePartId: 'cushion_2',
        regenHint: ''
      };
    case '眼镜盒':
      return {
        label,
        ruleId: 'curated_glasses_case',
        mode: 'compose',
        op: 'container_put',
        head: 'glasses',
        context: null,
        motion: 'drop_in',
        badgeText: '拼合示意',
        needsRegenFallback: false,
        referencePartId: 'glasses',
        regenHint: ''
      };
    case '充电宝':
      return {
        label,
        ruleId: 'curated_power_bank',
        mode: 'compose',
        op: 'link_flow',
        head: 'battery_1a',
        context: 'mobile_phone',
        motion: 'energy_flow',
        badgeText: '拼合示意',
        needsRegenFallback: false,
        referencePartId: 'battery_1a',
        regenHint: ''
      };
    case '折叠拐杖':
      return {
        label,
        ruleId: 'curated_folding_cane',
        mode: 'compose',
        op: 'modify_attr',
        head: 'walking_stick',
        context: null,
        motion: 'fold_hint',
        badgeText: '拼合示意',
        needsRegenFallback: false,
        referencePartId: 'walking_stick',
        regenHint: ''
      };
    case '打伞':
      return {
        label,
        ruleId: 'curated_hold_umbrella',
        mode: 'compose',
        op: 'act_with',
        head: 'umbrella',
        context: 'rain',
        motion: 'rain_block',
        badgeText: '拼合示意',
        needsRegenFallback: false,
        referencePartId: 'umbrella',
        regenHint: ''
      };
    case '血糖试纸':
      return {
        label,
        ruleId: 'curated_glucose_test_strip',
        mode: 'regen_from_ref',
        op: 'modify_attr',
        head: 'finger',
        context: 'blood_pressure',
        motion: 'pulse_head',
        badgeText: '待重绘',
        needsRegenFallback: true,
        referencePartId: 'blood_pressure',
        regenHint:
          'Minimal flat Mulberry-style AAC pictogram of a finger blood drop touching a white blood glucose test strip, zero text'
      };
    default:
      return null;
  }
}

function planSymbolComposition(rawLabel) {
  const label = sanitizeCompositionLabel(rawLabel);
  if (!label) {
    throw new Error('label is required');
  }

  const curated = buildCuratedExactRecipe(label);
  if (curated) {
    return {
      ...curated,
      license: MULBERRY_LICENSE,
      attribution: MULBERRY_ATTRIBUTION,
      sourceParts: summarizeSourceParts([curated.head, curated.context, curated.referencePartId])
    };
  }

  // Pattern 1: Sequence A -> B (先A再B / 先A后B)
  const seqMatch = label.match(/^先(.{1,6}?)(?:再|然后|后)(.{1,6})$/);
  if (seqMatch) {
    const partA = resolvePartForPhrase(seqMatch[1]);
    const partB = resolvePartForPhrase(seqMatch[2]);
    if (partA && partB) {
      return {
        label,
        ruleId: 'rule_sequence_ab',
        mode: 'compose',
        op: 'sequence_ab',
        head: partB.partId,
        context: partA.partId,
        stepALabel: sanitizeCompositionLabel(seqMatch[1]),
        stepBLabel: sanitizeCompositionLabel(seqMatch[2]),
        motion: 'sequence_pulse',
        badgeText: '顺序示意',
        needsRegenFallback: false,
        referencePartId: partA.partId,
        regenHint: '',
        license: MULBERRY_LICENSE,
        attribution: MULBERRY_ATTRIBUTION,
        sourceParts: summarizeSourceParts([partA.partId, partB.partId])
      };
    }
  }

  // Pattern 2: Modal or direct negation (不想X / 不要X / 别X / 不X)
  const negMatch = label.match(/^(不想|不要|别|不)(.{1,8})$/);
  if (negMatch) {
    const negPrefix = negMatch[1];
    const targetPhrase = negMatch[2].trim();
    const isModal = negPrefix === '不想' || negPrefix === '不要';
    const targetPart = resolvePartForPhrase(targetPhrase);
    if (targetPart) {
      const useEatActor =
        targetPart.partRole !== 'verb_action' &&
        /[吃喝药水饭茶奶果糖]/.test(targetPhrase);
      const contextPartId = useEatActor ? 'eat_1_to' : null;
      return {
        label,
        ruleId: isModal ? 'rule_negate_modal' : 'rule_negate_direct',
        mode: 'compose',
        op: 'negate_thought',
        head: targetPart.partId,
        context: contextPartId,
        isModal,
        motion: 'shake_no',
        badgeText: '拼合示意',
        needsRegenFallback: false,
        referencePartId: targetPart.partId,
        regenHint: '',
        license: MULBERRY_LICENSE,
        attribution: MULBERRY_ATTRIBUTION,
        sourceParts: summarizeSourceParts([targetPart.partId, contextPartId])
      };
    }
  }

  // Pattern 3: Container收纳 (*盒 / *盒子 / *收纳盒 / *箱)
  const boxMatch = label.match(/^(.{1,6}?)(?:收纳盒|盒子|盒|箱)$/);
  if (boxMatch) {
    const innerPart = resolvePartForPhrase(boxMatch[1]);
    if (innerPart) {
      return {
        label,
        ruleId: 'rule_container_put',
        mode: 'compose',
        op: 'container_put',
        head: innerPart.partId,
        context: null,
        motion: 'drop_in',
        badgeText: '拼合示意',
        needsRegenFallback: false,
        referencePartId: innerPart.partId,
        regenHint: '',
        license: MULBERRY_LICENSE,
        attribution: MULBERRY_ATTRIBUTION,
        sourceParts: summarizeSourceParts([innerPart.partId])
      };
    }
  }

  // Pattern 4: Surface location (*坐垫 / *软垫 / *垫子)
  const cushionMatch = label.match(/^(.{1,6}?)(?:坐垫|软垫|垫子|垫)$/);
  if (cushionMatch) {
    const carrierPart = resolvePartForPhrase(cushionMatch[1]);
    if (carrierPart) {
      return {
        label,
        ruleId: 'rule_locate_on',
        mode: 'compose',
        op: 'locate_on',
        head: 'cushion_2',
        context: carrierPart.partId,
        motion: 'pulse_head',
        badgeText: '拼合示意',
        needsRegenFallback: false,
        referencePartId: carrierPart.partId,
        regenHint: '',
        license: MULBERRY_LICENSE,
        attribution: MULBERRY_ATTRIBUTION,
        sourceParts: summarizeSourceParts(['cushion_2', carrierPart.partId])
      };
    }
  }

  // Pattern 4.5a: Direct verified whole-phrase library symbol match (e.g. 开灯 / 擦桌子 / 剪指甲 / 换尿不湿 / 测体温 / 洗头发)
  const exactRes = searchMulberryParts(label, { limit: 3 });
  const exactHit =
    exactRes.candidates &&
    exactRes.candidates.find(
      c =>
        (c.matchReason === 'exact_zh' || c.matchReason === 'exact_synonym_zh') &&
        c.score >= 920
    );
  if (exactHit) {
    return {
      label,
      ruleId: 'rule_exact_library_part',
      mode: 'compose',
      op: 'single_part',
      head: exactHit.partId,
      context: null,
      modifier: null,
      motion: 'pulse_head',
      badgeText: '标准图符',
      needsRegenFallback: false,
      referencePartId: exactHit.partId,
      regenHint: '',
      license: MULBERRY_LICENSE,
      attribution: MULBERRY_ATTRIBUTION,
      sourceParts: summarizeSourceParts([exactHit.partId])
    };
  }

  // Pattern 4.5b: Universal high-precision prefix attribute/action modifier rules (找X / 换X / 拉X / 调高X / 热X)
  for (const rule of MODIFIER_PREFIX_RULES) {
    const m = label.match(rule.re);
    if (!m || !m[2]) continue;
    const tail = m[2].trim();
    const targetPart = tail ? resolvePartForPhrase(tail) : null;
    if (targetPart) {
      return {
        label,
        ruleId: 'rule_modify_attr',
        mode: 'compose',
        op: 'modify_attr',
        head: targetPart.partId,
        context: null,
        modifier: rule.modifier,
        motion: `mod_${rule.modifier}`,
        badgeText: '拼合示意',
        needsRegenFallback: false,
        referencePartId: targetPart.partId,
        regenHint: '',
        license: MULBERRY_LICENSE,
        attribution: MULBERRY_ATTRIBUTION,
        sourceParts: summarizeSourceParts([targetPart.partId])
      };
    }
  }

  // Pattern 5: General compound part decomposition fallback
  const dec = decomposeConceptToMulberryParts(label);
  if (dec.matchedParts.length >= 2 && dec.recommendedTier === 'compose_ready') {
    const ctxPart = dec.matchedParts[0];
    const headPart = dec.matchedParts[dec.matchedParts.length - 1];
    return {
      label,
      ruleId: 'rule_focus_part_of_decompose',
      mode: 'compose',
      op: 'focus_part_of',
      head: headPart.partId,
      context: ctxPart.partId,
      motion: 'pulse_head',
      badgeText: '拼合示意',
      needsRegenFallback: false,
      referencePartId: headPart.partId,
      regenHint: '',
      license: MULBERRY_LICENSE,
      attribution: MULBERRY_ATTRIBUTION,
      sourceParts: summarizeSourceParts([headPart.partId, ctxPart.partId])
    };
  }

  if (dec.matchedParts.length >= 1) {
    const mainPart = dec.matchedParts[dec.matchedParts.length - 1];
    const isRegen = dec.recommendedTier === 'regen_from_ref';
    return {
      label,
      ruleId: isRegen ? 'rule_regen_single_anchor' : 'rule_single_part_with_modifier',
      mode: isRegen ? 'regen_from_ref' : 'compose',
      op: 'single_part',
      head: mainPart.partId,
      context: null,
      motion: 'pulse_head',
      badgeText: isRegen ? '待重绘' : '拼合示意',
      needsRegenFallback: isRegen,
      referencePartId: mainPart.partId,
      regenHint: isRegen
        ? `Minimal flat Mulberry-style AAC pictogram representing "${label}", bold uniform black outlines, white background, zero text`
        : '',
      license: MULBERRY_LICENSE,
      attribution: MULBERRY_ATTRIBUTION,
      sourceParts: summarizeSourceParts([mainPart.partId])
    };
  }

  return {
    label,
    ruleId: 'rule_regen_no_library_match',
    mode: 'regen_from_ref',
    op: 'regen_only',
    head: null,
    context: null,
    motion: 'none',
    badgeText: '待重绘',
    needsRegenFallback: true,
    referencePartId: null,
    regenHint: `Minimal flat Mulberry-style AAC pictogram representing "${label}", bold uniform black outlines, pure white background, zero text`,
    license: MULBERRY_LICENSE,
    attribution: MULBERRY_ATTRIBUTION,
    sourceParts: []
  };
}

function renderModifierBadgeMarkup(modifier, frameIdx, cx = 236, cy = 104) {
  const f = Math.max(0, Math.min(3, Number(frameIdx) || 0));
  const dy = [0, -3, -6, -2][f];
  const pulse = [0.92, 1.0, 1.08, 1.0][f];

  switch (modifier) {
    case 'hot':
      return `
        <g transform="translate(${cx}, ${cy})">
          <rect x="-34" y="-34" width="68" height="68" rx="16" fill="#FEF2F2" stroke="#FCA5A5" stroke-width="3"/>
          <g fill="none" stroke="#DC2626" stroke-width="5" stroke-linecap="round" transform="translate(0, ${dy})">
            <path d="M-16 18 Q-22 6 -14 -4 Q-6 -14 -14 -22"/>
            <path d="M0 20 Q-6 8 2 -2 Q10 -12 2 -22"/>
            <path d="M16 18 Q10 6 18 -4 Q26 -14 18 -22"/>
          </g>
        </g>
      `;
    case 'cold':
      return `
        <g transform="translate(${cx}, ${cy}) scale(${pulse})">
          <rect x="-34" y="-34" width="68" height="68" rx="16" fill="#EFF6FF" stroke="#93C5FD" stroke-width="3"/>
          <g stroke="#0284C7" stroke-width="5" stroke-linecap="round">
            <line x1="0" y1="-22" x2="0" y2="22"/>
            <line x1="-19" y1="-11" x2="19" y2="11"/>
            <line x1="-19" y1="11" x2="19" y2="-11"/>
          </g>
        </g>
      `;
    case 'up':
    case 'more':
      return `
        <g transform="translate(${cx}, ${cy})">
          <rect x="-34" y="-34" width="68" height="68" rx="16" fill="#F0FDF4" stroke="#86EFAC" stroke-width="3"/>
          <path d="M0 ${20 + dy} L0 ${-16 + dy} M-14 ${-4 + dy} L0 ${-20 + dy} L14 ${-4 + dy}" fill="none" stroke="#16A34A" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
        </g>
      `;
    case 'down':
    case 'less':
      return `
        <g transform="translate(${cx}, ${cy})">
          <rect x="-34" y="-34" width="68" height="68" rx="16" fill="#FFF7ED" stroke="#FDBA74" stroke-width="3"/>
          <path d="M0 ${-20 - dy} L0 ${16 - dy} M-14 ${4 - dy} L0 ${20 - dy} L14 ${4 - dy}" fill="none" stroke="#EA580C" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
        </g>
      `;
    case 'find': {
      const scanX = [-4, 0, 5, 0][f];
      return `
        <g transform="translate(${cx + scanX}, ${cy})">
          <rect x="-34" y="-34" width="68" height="68" rx="16" fill="#EFF6FF" stroke="#93C5FD" stroke-width="3"/>
          <circle cx="-5" cy="-5" r="15" fill="#FFFFFF" stroke="#0284C7" stroke-width="5.5"/>
          <line x1="7" y1="7" x2="21" y2="21" stroke="#1F2937" stroke-width="6.5" stroke-linecap="round"/>
        </g>
      `;
    }
    case 'replace':
      return `
        <g transform="translate(${cx}, ${cy}) scale(${pulse})">
          <rect x="-34" y="-34" width="68" height="68" rx="16" fill="#F0FDF4" stroke="#93C5FD" stroke-width="3"/>
          <path d="M-18 -8 A20 20 0 0 1 16 -12 M10 -18 L18 -10 L8 -4" fill="none" stroke="#0284C7" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M18 8 A20 20 0 0 1 -16 12 M-10 18 L-18 10 L-8 4" fill="none" stroke="#16A34A" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
        </g>
      `;
    case 'open': {
      const spread = [0, 3, 6, 4][f];
      return `
        <g transform="translate(${cx}, ${cy})">
          <rect x="-34" y="-34" width="68" height="68" rx="16" fill="#EFF6FF" stroke="#93C5FD" stroke-width="3"/>
          <path d="M${-4 - spread} 0 L${-22 - spread} 0 M${-15 - spread} -9 L${-23 - spread} 0 L${-15 - spread} 9" fill="none" stroke="#0284C7" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M${4 + spread} 0 L${22 + spread} 0 M${15 + spread} -9 L${23 + spread} 0 L${15 + spread} 9" fill="none" stroke="#0284C7" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
        </g>
      `;
    }
    case 'close': {
      const squeeze = [6, 3, 0, 2][f];
      return `
        <g transform="translate(${cx}, ${cy})">
          <rect x="-34" y="-34" width="68" height="68" rx="16" fill="#FFF7ED" stroke="#FDBA74" stroke-width="3"/>
          <path d="M${-24 + squeeze} 0 L${-6 + squeeze} 0 M${-13 + squeeze} -9 L${-5 + squeeze} 0 L${-13 + squeeze} 9" fill="none" stroke="#EA580C" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M${24 - squeeze} 0 L${6 - squeeze} 0 M${13 - squeeze} -9 L${5 - squeeze} 0 L${13 - squeeze} 9" fill="none" stroke="#EA580C" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
        </g>
      `;
    }
    case 'clean':
      return `
        <g transform="translate(${cx}, ${cy}) scale(${pulse})">
          <rect x="-34" y="-34" width="68" height="68" rx="16" fill="#F0F9FF" stroke="#7DD3FC" stroke-width="3"/>
          <path d="M-4 -22 L0 -8 L14 -4 L0 0 L-4 14 L-8 0 L-22 -4 L-8 -8 Z" fill="#F59E0B" stroke="#1F2937" stroke-width="2"/>
          <path d="M14 4 L17 11 L24 14 L17 17 L14 24 L11 17 L4 14 L11 11 Z" fill="#0284C7"/>
        </g>
      `;
    case 'fold':
      return `
        <g transform="translate(${cx}, ${cy}) scale(${pulse})">
          <rect x="-34" y="-34" width="68" height="68" rx="16" fill="#FFF7ED" stroke="#FDBA74" stroke-width="3"/>
          <path d="M-16 14 L-2 -14 L16 12" fill="none" stroke="#1F2937" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="-2" cy="-14" r="6" fill="#F59E0B" stroke="#1F2937" stroke-width="2.5"/>
          <path d="M-16 -2 Q-2 -20 14 -4" fill="none" stroke="#EA580C" stroke-width="4" stroke-dasharray="4 3"/>
        </g>
      `;
    case 'broken':
      return `
        <g transform="translate(${cx}, ${cy}) scale(${pulse})">
          <rect x="-34" y="-34" width="68" height="68" rx="16" fill="#FEF2F2" stroke="#FCA5A5" stroke-width="3"/>
          <path d="M4 -22 L-10 -2 L4 2 L-8 22" fill="none" stroke="#DC2626" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
        </g>
      `;
    default:
      return '';
  }
}

function buildFrameLayers(recipe, frameIdx, includeLabel) {
  const f = Math.max(0, Math.min(3, Number(frameIdx) || 0));
  const yShift = includeLabel ? 0 : 18;
  const slotPrefix = (slot) => `f${f}_${slot}`;

  if (recipe.ruleId === 'curated_wheelchair_cushion') {
    const pulse = [0, 3, 6, 3][f];
    const arrowY = [36, 42, 48, 44][f] + yShift;
    return `
      ${embedCleanMulberryPart('wheelchair', 48, 44 + yShift, 202, 184, {
        opacity: 0.36,
        grayscale: true,
        instancePrefix: slotPrefix('ctx')
      })}
      <g transform="translate(92, ${46 + yShift}) scale(0.175)">
        <path d="M640.28 466.57c3.77 7.01 5.95 15.31 5.95 24.22v21.16c0 25.03-17.261 45.33-38.561 45.33H236.15c-21.3 0-38.57-20.3-38.57-45.33v-21.16c0-7.61 1.59-14.78 4.41-21.07 6.46-14.43 19.33-24.27 34.16-24.27h371.52c13.72 0 25.77 8.43 32.61 21.12z" fill="#FBBF24" stroke="#1F2937" stroke-width="26"/>
        <path d="M640.28 466.57c-6.84-12.69-18.891-21.12-32.61-21.12H236.15c-14.83 0-27.7 9.84-34.16 24.27-.06-2.7.62-24.71 36.73-49.979 7.5-5.25 14.17-9.43 20.06-12.76 24.38-13.79 35.22-12.95 35.22-12.95l125.12-2.5 132.62 2.5s10.85-.84 35.22 12.94c5.89 3.33 12.57 7.52 20.07 12.77 29.72 20.799 33.21 39.399 33.25 46.829z" fill="#FDE047" stroke="#1F2937" stroke-width="26"/>
      </g>
      <rect x="116" y="${104 - pulse / 2 + yShift}" width="96" height="${42 + pulse}" rx="12" fill="none" stroke="#EA580C" stroke-width="4" opacity="${f >= 1 ? 0.95 : 0.45}"/>
      <path d="M164 ${arrowY} L164 ${arrowY + 42}" stroke="#0284C7" stroke-width="6" stroke-linecap="round" marker-end="url(#blueArrow)"/>
    `;
  }

  if (recipe.op === 'focus_part_of' && recipe.head && recipe.context) {
    const scales = [0.94, 1.0, 1.06, 1.02];
    const s = scales[f];
    const bw = 122 * s;
    const bh = 154 * s;
    const bx = 136 - (bw - 122) / 2;
    const by = 60 + yShift - (bh - 154) / 2;
    const ringOpacity = f >= 2 ? 0.9 : 0.38;
    return `
      <rect x="14" y="${42 + yShift}" width="88" height="96" rx="14" fill="#F8FAFC" stroke="#64748B" stroke-width="3" stroke-dasharray="6 4"/>
      ${embedCleanMulberryPart(recipe.context, 20, 48 + yShift, 76, 84, {
        opacity: 0.45,
        instancePrefix: slotPrefix('ctx')
      })}
      <path d="M104 ${112 + yShift} L130 ${136 + yShift}" stroke="#0284C7" stroke-width="5" stroke-linecap="round" marker-end="url(#blueArrow)"/>
      <circle cx="197" cy="${137 + yShift}" r="72" fill="none" stroke="#F59E0B" stroke-width="4" stroke-dasharray="8 6" opacity="${ringOpacity}"/>
      ${embedCleanMulberryPart(recipe.head, bx, by, bw, bh, {
        opacity: 1.0,
        instancePrefix: slotPrefix('head')
      })}
    `;
  }

  if (recipe.op === 'locate_on' && recipe.head && recipe.context) {
    const pulse = [0, 3, 6, 3][f];
    return `
      ${embedCleanMulberryPart(recipe.context, 48, 44 + yShift, 204, 184, {
        opacity: 0.36,
        grayscale: true,
        instancePrefix: slotPrefix('ctx')
      })}
      <rect x="108" y="${96 - pulse / 2 + yShift}" width="84" height="${64 + pulse}" rx="14" fill="#FEF3C7" fill-opacity="0.82" stroke="#EA580C" stroke-width="4"/>
      ${embedCleanMulberryPart(recipe.head, 114, 100 + yShift, 72, 56, {
        opacity: 1.0,
        instancePrefix: slotPrefix('head')
      })}
      <path d="M150 ${42 + yShift} L150 ${82 + yShift}" stroke="#0284C7" stroke-width="5" stroke-linecap="round" marker-end="url(#blueArrow)"/>
    `;
  }

  if (recipe.op === 'container_put' && recipe.head) {
    // Animate object dropping into open case on f=0..2; rest inside WITHOUT arrow on f=3
    const dropY = [48, 78, 106, 122][f] + yShift;
    const lidTilt = [0, 0, -4, -6][f];
    const arrowMarkup =
      f < 3
        ? `<path d="M150 ${38 + yShift} L150 ${Math.max(46 + yShift, dropY - 4)}" stroke="#0284C7" stroke-width="5" stroke-linecap="round" marker-end="url(#blueArrow)"/>`
        : '';
    return `
      <g transform="translate(0, ${yShift})">
        <path d="M56 132 L70 68 Q150 54 230 68 L244 132 Z" fill="#1E40AF" stroke="#1F2937" stroke-width="6" stroke-linejoin="round" transform="rotate(${lidTilt} 150 132)"/>
        <path d="M70 128 L80 82 Q150 70 220 82 L230 128 Z" fill="#DBEAFE" stroke="#1F2937" stroke-width="4" transform="rotate(${lidTilt} 150 132)"/>
        <rect x="46" y="130" width="208" height="88" rx="22" fill="#3B82F6" stroke="#1F2937" stroke-width="6"/>
        <rect x="60" y="140" width="180" height="58" rx="14" fill="#EFF6FF" stroke="#1F2937" stroke-width="4"/>
      </g>
      ${embedCleanMulberryPart(recipe.head, 82, dropY, 136, 80, {
        opacity: 1.0,
        instancePrefix: slotPrefix('head')
      })}
      <path d="M46 ${190 + yShift} Q150 ${204 + yShift} 254 ${190 + yShift} L254 ${200 + yShift} Q254 ${218 + yShift} 232 ${218 + yShift} L68 ${218 + yShift} Q46 ${218 + yShift} 46 ${200 + yShift} Z" fill="#2563EB" stroke="#1F2937" stroke-width="6"/>
      ${arrowMarkup}
    `;
  }

  if (recipe.op === 'link_flow' && recipe.head && recipe.context) {
    const boltX = [124, 140, 158, 150][f];
    const glowOp = [0.45, 0.75, 1.0, 0.9][f];
    return `
      <g transform="translate(0, ${yShift})">
        <rect x="18" y="64" width="94" height="148" rx="16" fill="#E2E8F0" stroke="#1F2937" stroke-width="5"/>
        <rect x="44" y="54" width="42" height="12" rx="4" fill="#334155"/>
        ${embedCleanMulberryPart(recipe.head, 28, 76, 74, 124, {
          opacity: 1.0,
          instancePrefix: slotPrefix('head')
        })}
        <path d="M112 142 Q150 106 186 142" fill="none" stroke="#0284C7" stroke-width="7" stroke-linecap="round"/>
        <circle cx="${boltX}" cy="122" r="18" fill="#FEF08A" stroke="#CA8A04" stroke-width="3" opacity="${glowOp}"/>
        <polygon points="${boltX + 2},109 ${boltX - 8},124 ${boltX},124 ${boltX - 4},135 ${boltX + 9},119 ${boltX + 1},119" fill="#F59E0B" stroke="#78350F" stroke-width="1.5"/>
        ${embedCleanMulberryPart(recipe.context, 184, 58, 98, 162, {
          opacity: 1.0,
          instancePrefix: slotPrefix('ctx')
        })}
      </g>
    `;
  }

  if (recipe.ruleId === 'curated_folding_cane' && recipe.head) {
    const foldGap = [12, 6, 0, 4][f];
    return `
      <g transform="translate(0, ${yShift})">
        ${embedCleanMulberryPart(recipe.head, 20, 44, 128, 184, {
          opacity: 0.78,
          instancePrefix: slotPrefix('head')
        })}
        <path d="M148 92 C164 78 176 78 188 92" fill="none" stroke="#0284C7" stroke-width="5" stroke-linecap="round" marker-end="url(#blueArrow)"/>
        <!-- Clear visual representation of a folding cane hinged in two segments -->
        <g stroke="#1F2937" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" fill="none">
          <path d="M214 60 Q232 48 232 68 L210 ${136 - foldGap}"/>
          <path d="M210 ${136 - foldGap} L248 206"/>
        </g>
        <circle cx="210" cy="${136 - foldGap}" r="11" fill="#F59E0B" stroke="#1F2937" stroke-width="4"/>
        <path d="M262 ${114} A26 26 0 0 1 258 ${164}" fill="none" stroke="#EA580C" stroke-width="4.5" stroke-dasharray="5 4"/>
      </g>
    `;
  }

  if (recipe.ruleId === 'curated_hold_umbrella' && recipe.head && recipe.context) {
    const rainOffset = [0, 6, 12, 8][f];
    const umbLift = [5, 2, 0, 0][f];
    return `
      <g opacity="0.88">
        ${embedCleanMulberryPart(recipe.context, 76, 36 + yShift + rainOffset * 0.4, 148, 60, {
          opacity: 0.85,
          instancePrefix: slotPrefix('ctx')
        })}
      </g>
      <g stroke="#1F2937" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" transform="translate(0, ${yShift + 10})">
        <circle cx="110" cy="148" r="24" fill="#FDE68A"/>
        <path d="M74 222 C76 184 144 184 146 222 Z" fill="#60A5FA"/>
        <path d="M138 194 L168 176 L168 158" fill="none" stroke-width="9"/>
      </g>
      ${embedCleanMulberryPart(recipe.head, 74, 62 + umbLift + yShift, 178, 128, {
        opacity: 1.0,
        instancePrefix: slotPrefix('head')
      })}
    `;
  }

  if (recipe.op === 'act_with' && recipe.head && recipe.context) {
    const slideX = [0, 5, 10, 6][f];
    const hasMod = Boolean(recipe.modifier);
    const modifierBadge = hasMod
      ? `<g transform="translate(238, ${72 + yShift}) scale(0.82)">${renderModifierBadgeMarkup(recipe.modifier, f, 0, 0)}</g>`
      : '';
    return `
      <g>
        ${embedCleanMulberryPart(recipe.head, 18 + slideX, 54 + yShift, 114, 124, {
          opacity: 1.0,
          instancePrefix: slotPrefix('head')
        })}
        <path d="M124 ${132 + yShift} L156 ${152 + yShift}" stroke="#0284C7" stroke-width="5.5" stroke-linecap="round" marker-end="url(#blueArrow)"/>
        ${embedCleanMulberryPart(recipe.context, 152, (hasMod ? 108 : 92) + yShift, 124, hasMod ? 116 : 130, {
          opacity: 1.0,
          instancePrefix: slotPrefix('ctx')
        })}
        ${modifierBadge}
      </g>
    `;
  }

  if (recipe.op === 'negate_thought' && recipe.head) {
    const shakeX = [0, -5, 5, 0][f];
    const forbidScale = [0.8, 0.92, 1.04, 1.0][f];
    if (recipe.context) {
      return `
        ${embedCleanMulberryPart(recipe.context, 12, 68 + yShift, 118, 152, {
          opacity: 0.72,
          instancePrefix: slotPrefix('ctx')
        })}
        <g transform="translate(${shakeX}, ${yShift})">
          <circle cx="128" cy="144" r="7" fill="#F8FAFC" stroke="#0284C7" stroke-width="4"/>
          <circle cx="144" cy="130" r="10" fill="#F8FAFC" stroke="#0284C7" stroke-width="4"/>
          <ellipse cx="212" cy="136" rx="68" ry="56" fill="#F8FAFC" stroke="#0284C7" stroke-width="5" stroke-dasharray="10 6"/>
          ${embedCleanMulberryPart(recipe.head, 162, 92, 96, 86, {
            opacity: 1.0,
            instancePrefix: slotPrefix('head')
          })}
          <g transform="translate(248, 92) scale(${forbidScale})">
            <circle r="27" fill="#FFFFFF" opacity="0.95"/>
            <circle r="21" fill="none" stroke="#E11D48" stroke-width="6.5"/>
            <line x1="-14" y1="-14" x2="14" y2="14" stroke="#E11D48" stroke-width="6.5" stroke-linecap="round"/>
          </g>
        </g>
      `;
    }
    // Centered target + dashed thought/negation emphasis + unmistakable top-layer prohibition circle
    return `
      <g transform="translate(${shakeX}, ${yShift})">
        <ellipse cx="150" cy="138" rx="88" ry="74" fill="#F8FAFC" stroke="#0284C7" stroke-width="4.5" stroke-dasharray="10 6"/>
        ${embedCleanMulberryPart(recipe.head, 86, 80, 128, 118, {
          opacity: 0.92,
          instancePrefix: slotPrefix('head')
        })}
        <g transform="translate(220, 82) scale(${forbidScale})">
          <circle r="29" fill="#FFFFFF" opacity="0.95"/>
          <circle r="23" fill="none" stroke="#E11D48" stroke-width="7"/>
          <line x1="-15" y1="-15" x2="15" y2="15" stroke="#E11D48" stroke-width="7" stroke-linecap="round"/>
        </g>
      </g>
    `;
  }

  if (recipe.op === 'sequence_ab' && recipe.context && recipe.head) {
    const leftStroke = f === 0 || f === 1 ? '#0284C7' : '#94A3B8';
    const rightStroke = f === 2 || f === 3 ? '#16A34A' : '#94A3B8';
    const leftWidth = f === 0 || f === 1 ? 4 : 2.5;
    const rightWidth = f === 2 || f === 3 ? 4 : 2.5;
    return `
      <g transform="translate(0, ${yShift})">
        <rect x="14" y="54" width="116" height="168" rx="14" fill="#F8FAFC" stroke="${leftStroke}" stroke-width="${leftWidth}"/>
        <circle cx="34" cy="74" r="13" fill="#0284C7"/>
        <text x="34" y="79" text-anchor="middle" font-size="14" font-weight="700" font-family="Microsoft YaHei, SimHei, sans-serif" fill="#FFFFFF">1</text>
        ${embedCleanMulberryPart(recipe.context, 24, 92, 96, 118, {
          opacity: 1.0,
          instancePrefix: slotPrefix('ctx')
        })}

        <path d="M134 138 L162 138" stroke="#0284C7" stroke-width="6" stroke-linecap="round" marker-end="url(#blueArrow)"/>

        <rect x="170" y="54" width="116" height="168" rx="14" fill="#F8FAFC" stroke="${rightStroke}" stroke-width="${rightWidth}"/>
        <circle cx="190" cy="74" r="13" fill="#16A34A"/>
        <text x="190" y="79" text-anchor="middle" font-size="14" font-weight="700" font-family="Microsoft YaHei, SimHei, sans-serif" fill="#FFFFFF">2</text>
        ${embedCleanMulberryPart(recipe.head, 180, 92, 96, 118, {
          opacity: 1.0,
          instancePrefix: slotPrefix('head')
        })}
      </g>
    `;
  }

  if (recipe.ruleId === 'curated_glucose_test_strip') {
    const dropY = [126, 136, 144, 142][f] + yShift;
    const dropR = [9, 10.2, 11.8, 10.8][f];
    const padOpacity = [0.4, 0.7, 1.0, 0.85][f];
    return `
      <g transform="translate(8, ${yShift + 10}) rotate(138 92 70)">
        ${embedCleanMulberryPart('finger', 36, 18, 110, 110, {
          opacity: 1.0,
          instancePrefix: slotPrefix('head')
        })}
      </g>
      <path d="M138 ${dropY - dropR * 1.4} C148 ${dropY - 2} ${138 + dropR} ${dropY + dropR} 138 ${dropY + dropR} C${138 - dropR} ${dropY + dropR} 128 ${dropY - 2} 138 ${dropY - dropR * 1.4} Z" fill="#DC2626" stroke="#1F2937" stroke-width="4"/>
      <g transform="translate(132, ${162 + yShift}) rotate(20)">
        <rect x="0" y="0" width="122" height="40" rx="8" fill="#FFFFFF" stroke="#1F2937" stroke-width="6"/>
        <rect x="4" y="4" width="24" height="32" rx="4" fill="#14B8A6" opacity="${padOpacity}"/>
        <rect x="-2" y="-2" width="32" height="44" rx="8" fill="none" stroke="#F59E0B" stroke-width="3" opacity="${padOpacity}"/>
        <line x1="90" y1="8" x2="90" y2="32" stroke="#475569" stroke-width="5"/>
        <line x1="101" y1="8" x2="101" y2="32" stroke="#475569" stroke-width="5"/>
        <line x1="112" y1="8" x2="112" y2="32" stroke="#475569" stroke-width="5"/>
      </g>
    `;
  }

  if (recipe.op === 'modify_attr' && recipe.head && recipe.modifier) {
    return `
      <g>
        ${embedCleanMulberryPart(recipe.head, 26, 56 + yShift, 160, 158, {
          opacity: 1.0,
          instancePrefix: slotPrefix('head')
        })}
        ${renderModifierBadgeMarkup(recipe.modifier, f, 234, 134 + yShift)}
      </g>
    `;
  }

  if (recipe.head) {
    const sc = [0.95, 1.0, 1.04, 1.0][f];
    const w = 176 * sc;
    const h = 166 * sc;
    return embedCleanMulberryPart(recipe.head, (300 - w) / 2, 52 + yShift + (166 - h) / 2, w, h, {
      opacity: 1.0,
      instancePrefix: slotPrefix('head')
    });
  }

  // No-library-match neutral placeholder graphic (safe XML)
  return `
    <g transform="translate(0, ${yShift})">
      <rect x="52" y="56" width="196" height="162" rx="22" fill="#FFFBEB" stroke="#D97706" stroke-width="4" stroke-dasharray="10 6"/>
      <circle cx="150" cy="137" r="42" fill="#FEF3C7" stroke="#D97706" stroke-width="4"/>
    </g>
  `;
}

function renderRecipeToSvg(recipe, options = {}) {
  const frameIdx = Number.isInteger(options.frameIdx) ? options.frameIdx : 3;
  const includeLabel = options.includeLabel !== false;
  const labelText = escapeXml(sanitizeCompositionLabel(recipe.label));
  const badgeText = escapeXml(recipe.badgeText || '拼合示意');
  const badgeBg = recipe.needsRegenFallback ? '#FEF3C7' : '#E0F2FE';
  const badgeFg = recipe.needsRegenFallback ? '#B45309' : '#0369A1';
  const innerLayers = buildFrameLayers(recipe, frameIdx, includeLabel);

  const labelLen = sanitizeCompositionLabel(recipe.label).length;
  const fontSize = labelLen <= 5 ? 26 : labelLen <= 7 ? 21 : 17;
  const textY = labelLen <= 5 ? 276 : labelLen <= 7 ? 275 : 274;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${COMPOSER_CANVAS_SIZE} ${COMPOSER_CANVAS_SIZE}" width="${COMPOSER_CANVAS_SIZE}" height="${COMPOSER_CANVAS_SIZE}">
  <defs>
    <filter id="gray"><feColorMatrix type="saturate" values="0.1"/></filter>
    <marker id="blueArrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto">
      <path d="M 0 1 L 8 5 L 0 9 z" fill="#0284C7"/>
    </marker>
  </defs>
  <rect width="300" height="300" rx="20" fill="#FFFFFF" stroke="${includeLabel ? '#CBD5E1' : 'none'}" stroke-width="${includeLabel ? 4 : 0}"/>
  ${innerLayers}
  ${
    includeLabel
      ? `<rect x="212" y="10" width="78" height="24" rx="8" fill="${badgeBg}"/>
  <text x="251" y="27" text-anchor="middle" font-size="13" font-weight="700" font-family="Microsoft YaHei, SimHei, sans-serif" fill="${badgeFg}">${badgeText}</text>
  <rect x="8" y="242" width="284" height="50" rx="12" fill="#F1F5F9"/>
  <text x="150" y="${textY}" text-anchor="middle" font-size="${fontSize}" font-weight="700" font-family="Microsoft YaHei, SimHei, sans-serif" fill="#0F172A">${labelText}</text>`
      : ''
  }
</svg>`;
}

async function renderSvgToPngBuffer(svgString) {
  return sharp(Buffer.from(svgString, 'utf8'))
    .resize(COMPOSER_CANVAS_SIZE, COMPOSER_CANVAS_SIZE)
    .flatten({ background: '#ffffff' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function renderRecipeToAnimatedGif(recipe, { includeLabel = true } = {}) {
  const frameRawBuffers = [];
  for (let i = 0; i < 4; i += 1) {
    const svg = renderRecipeToSvg(recipe, { frameIdx: i, includeLabel });
    const raw = await sharp(Buffer.from(svg, 'utf8'))
      .resize(COMPOSER_CANVAS_SIZE, COMPOSER_CANVAS_SIZE)
      .flatten({ background: '#ffffff' })
      .ensureAlpha()
      .raw()
      .toBuffer();
    frameRawBuffers.push(raw);
  }

  const strip = Buffer.concat(frameRawBuffers);
  const encodedGif = await sharp(strip, {
    raw: {
      width: COMPOSER_CANVAS_SIZE,
      height: COMPOSER_CANVAS_SIZE * 4,
      channels: 4,
      pageHeight: COMPOSER_CANVAS_SIZE
    }
  })
    .gif({
      colours: 32,
      dither: 0,
      effort: 5,
      delay: Array.from(DEFAULT_FRAME_DELAYS_MS),
      loop: 2
    })
    .toBuffer();

  return normalizePublicPictogramImage(encodedGif, {
    allowAnimatedGif: true
  });
}

async function composeMissingPictogram(rawLabel, options = {}) {
  const t0 = Date.now();
  const format = String(options.format || 'all').trim().toLowerCase();
  if (!['svg', 'png', 'gif', 'all'].includes(format)) {
    throw new Error(`Unsupported compose format: ${format}`);
  }
  const includeLabel = options.includeLabel !== false;
  const includeNoLabelPng = Boolean(options.includeNoLabelPng);

  const recipe =
    options.recipe && typeof options.recipe === 'object'
      ? {
          ...options.recipe,
          label: sanitizeCompositionLabel(options.recipe.label || rawLabel),
          license: options.recipe.license || MULBERRY_LICENSE,
          attribution: options.recipe.attribution || MULBERRY_ATTRIBUTION
        }
      : planSymbolComposition(rawLabel);
  const svg = renderRecipeToSvg(recipe, { frameIdx: 3, includeLabel });

  let pngBuffer = null;
  let noLabelPngBuffer = null;
  let gifResult = null;

  if (format === 'png' || format === 'all') {
    pngBuffer = await renderSvgToPngBuffer(svg);
  }
  if (includeNoLabelPng) {
    const noLabelSvg = renderRecipeToSvg(recipe, { frameIdx: 3, includeLabel: false });
    noLabelPngBuffer = await renderSvgToPngBuffer(noLabelSvg);
  }
  if (format === 'gif' || format === 'all') {
    gifResult = await renderRecipeToAnimatedGif(recipe, { includeLabel });
  }

  return {
    recipe,
    svg,
    pngBuffer,
    noLabelPngBuffer,
    gifBuffer: gifResult ? gifResult.buffer : null,
    gifInfo: gifResult
      ? {
          contentType: gifResult.contentType,
          pages: gifResult.pages,
          width: gifResult.width,
          height: gifResult.height,
          bytes: gifResult.buffer.length
        }
      : null,
    metrics: {
      renderMs: Date.now() - t0,
      svgBytes: Buffer.byteLength(svg, 'utf8'),
      pngBytes: pngBuffer ? pngBuffer.length : null,
      gifBytes: gifResult ? gifResult.buffer.length : null
    }
  };
}

module.exports = {
  ALLOWED_MODIFIERS,
  ALLOWED_RECIPE_OPS,
  COMPOSER_CANVAS_SIZE,
  DEFAULT_FRAME_DELAYS_MS,
  MAX_COMPOSITION_LABEL_LENGTH,
  MULBERRY_ATTRIBUTION,
  MULBERRY_LICENSE,
  composeMissingPictogram,
  escapeXml,
  planSymbolComposition,
  renderModifierBadgeMarkup,
  renderRecipeToSvg,
  sanitizeCompositionLabel,
  summarizeSourceParts
};

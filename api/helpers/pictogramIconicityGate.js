'use strict';

const { MAX_PICTOGRAM_IMAGE_BYTES, isPngBuffer } = require('./pictogramImage');

const NEGATION_PREFIX_RE = /^(不想|不要|别|不|没)(.{1,8})$/;
const NEGATION_MORPHEME_RE = /[不没别拒禁勿停]/;
const FUNCTION_CHARS_RE = /[的了把在去打不想也要用和与及]/g;

const COMPOUND_BARE_CARRIER_RULES = Object.freeze({
  轮椅坐垫: {
    bareTerms: ['轮椅', '椅子', '座位'],
    requiredModifiers: ['坐垫', '软垫', '靠垫', '垫', '防褥疮']
  },
  充电宝: {
    bareTerms: ['插座', '充电器', '插头'],
    requiredModifiers: ['充电宝', '移动电源', '便携', '电池']
  },
  眼镜盒: {
    bareTerms: ['眼镜', '眼镜框'],
    requiredModifiers: ['盒', '箱', '包', '收纳']
  }
});

const UNCONDITIONAL_FORBIDDEN_BY_LABEL = Object.freeze({
  眼镜盒: ['拳击', '打拳', '拳击手', '拳套', '木琴'],
  折叠拐杖: ['拐杖糖', '糖果', '树枝', '枝条'],
  流泪: ['哭', '大哭', '伤心', '痛哭']
});

function normalizeStringList(values) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const s = String(raw || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function buildForbiddenConfusionsForLabel(targetLabel, extraForbidden = []) {
  const cleanTarget = String(targetLabel || '').trim();
  const terms = [];

  if (Object.prototype.hasOwnProperty.call(UNCONDITIONAL_FORBIDDEN_BY_LABEL, cleanTarget)) {
    terms.push(...UNCONDITIONAL_FORBIDDEN_BY_LABEL[cleanTarget]);
  }
  if (Object.prototype.hasOwnProperty.call(COMPOUND_BARE_CARRIER_RULES, cleanTarget)) {
    terms.push(...COMPOUND_BARE_CARRIER_RULES[cleanTarget].bareTerms);
  }

  const negMatch = cleanTarget.match(NEGATION_PREFIX_RE);
  if (negMatch && negMatch[2]) {
    const core = negMatch[2].trim();
    if (core) terms.push(core);
  }

  terms.push(...normalizeStringList(extraForbidden));
  return normalizeStringList(terms);
}

function parseBlindGuesses(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) return [];

  const cleanedLines = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/[\r\n]+/)
    .map(line => line.replace(/^\s*(?:[-*•]+|\d+[.)、:：])\s*/, '').trim())
    .filter(Boolean)
    .join(',');

  const tokens = cleanedLines
    .split(/[,，、;；/]+/)
    .map(part =>
      part
        .replace(/^\s*(?:[-*•]|\d+[.)、:：])\s*/, '')
        .replace(/^[\s"'“”‘’()（）[\]【】]+|[\s"'“”‘’()（）[\]【】。！!？?]+$/g, '')
        .trim()
    )
    .filter(item => item.length > 0 && item.length <= 16);

  return normalizeStringList(tokens).slice(0, 3);
}

function stripFunctionChars(text) {
  return String(text || '').replace(FUNCTION_CHARS_RE, '').trim();
}

function matchesTerm(guess, validSet) {
  for (const term of validSet) {
    if (!term) continue;
    if (guess === term || guess.includes(term)) return true;
  }
  return false;
}

function hasSharedContentMorpheme(guess, targetCore) {
  const gClean = stripFunctionChars(guess);
  const tClean = stripFunctionChars(targetCore);
  if (!gClean || !tClean) return false;
  if (gClean === tClean || gClean.includes(tClean) || tClean.includes(gClean)) {
    return true;
  }
  if (tClean.length >= 2) {
    for (let i = 0; i < tClean.length - 1; i += 1) {
      if (gClean.includes(tClean.slice(i, i + 2))) return true;
    }
  }
  for (const ch of tClean) {
    if (ch.trim() && gClean.includes(ch)) return true;
  }
  return false;
}

function evaluateBlindIconicityGuesses({
  guesses = [],
  targetLabel = '',
  allowedSynonyms = [],
  forbiddenConfusions = []
} = {}) {
  const cleanTarget = String(targetLabel || '').trim();
  const cleanGuesses = normalizeStringList(guesses).slice(0, 3);
  const top1 = cleanGuesses[0] || '';
  const validSet = new Set(normalizeStringList([cleanTarget, ...allowedSynonyms]));

  // 1. Negation polarity reversal check (highest priority safety gate)
  const negMatch = cleanTarget.match(NEGATION_PREFIX_RE);
  if (negMatch) {
    const actionCore = negMatch[2].trim();
    if (
      top1 &&
      !NEGATION_MORPHEME_RE.test(top1) &&
      (top1 === actionCore ||
        top1.includes(actionCore) ||
        hasSharedContentMorpheme(top1, actionCore))
    ) {
      return {
        passed: false,
        tier: 'misleading_rejected',
        reason: 'negation_swallowed',
        matchedForbidden: top1,
        top1Hit: false,
        needsLabel: false,
        guesses: cleanGuesses
      };
    }
  }

  // 2. Compound bare-carrier drift check (e.g., 轮椅坐垫 guessed as bare 轮椅 on Top-1)
  const bareRule = COMPOUND_BARE_CARRIER_RULES[cleanTarget];
  if (bareRule && top1) {
    const hasModifier = bareRule.requiredModifiers.some(mod => top1.includes(mod));
    const hitBare = bareRule.bareTerms.some(bare => top1 === bare || top1.includes(bare));
    if (hitBare && !hasModifier) {
      return {
        passed: false,
        tier: 'misleading_rejected',
        reason: 'forbidden_confusion',
        matchedForbidden: top1,
        top1Hit: false,
        needsLabel: false,
        guesses: cleanGuesses
      };
    }
  }

  // 3. Unconditional high-risk & caller-specified forbidden confusions
  const builtInUnconditional = UNCONDITIONAL_FORBIDDEN_BY_LABEL[cleanTarget] || [];
  const callerExtra = normalizeStringList(forbiddenConfusions);
  const allUnconditional = normalizeStringList([...builtInUnconditional, ...callerExtra]);

  for (const bad of allUnconditional) {
    // Allow qualified bare term when explicitly marked valid or when target itself includes bad (only test Top-1 bare mismatch above)
    if (cleanTarget.includes(bad)) {
      if (top1 && (top1 === bad || (top1.includes(bad) && !matchesTerm(top1, validSet)))) {
        return {
          passed: false,
          tier: 'misleading_rejected',
          reason: 'forbidden_confusion',
          matchedForbidden: bad,
          top1Hit: false,
          needsLabel: false,
          guesses: cleanGuesses
        };
      }
      continue;
    }

    const hit = cleanGuesses.find(g => !matchesTerm(g, validSet) && (g === bad || g.includes(bad)));
    if (hit) {
      return {
        passed: false,
        tier: 'misleading_rejected',
        reason: 'forbidden_confusion',
        matchedForbidden: bad,
        top1Hit: false,
        needsLabel: false,
        guesses: cleanGuesses
      };
    }
  }

  // 4. Transparent match (Top-1 or Top-3 exact / synonym match)
  const top1Hit = Boolean(top1 && matchesTerm(top1, validSet));
  const anyTransparent = cleanGuesses.some(g => matchesTerm(g, validSet));
  if (anyTransparent) {
    return {
      passed: true,
      tier: 'transparent',
      reason: top1Hit ? 'top1_exact' : 'top3_exact',
      matchedForbidden: null,
      top1Hit,
      needsLabel: false,
      guesses: cleanGuesses
    };
  }

  // 5. Translucent (shares content morpheme and preserves polarity for negated expressions)
  const targetCore = negMatch ? negMatch[2].trim() : cleanTarget;
  const anyTranslucent = cleanGuesses.some(g => {
    if (negMatch && !NEGATION_MORPHEME_RE.test(g)) return false;
    return hasSharedContentMorpheme(g, targetCore);
  });
  if (anyTranslucent) {
    return {
      passed: true,
      tier: 'translucent_needs_label',
      reason: 'shared_morpheme',
      matchedForbidden: null,
      top1Hit: false,
      needsLabel: true,
      guesses: cleanGuesses
    };
  }

  // 6. Opaque / unrelated guesses -> rejected
  return {
    passed: false,
    tier: 'opaque_rejected',
    reason: 'unrelated_guesses',
    matchedForbidden: null,
    top1Hit: false,
    needsLabel: false,
    guesses: cleanGuesses
  };
}

async function verifyIconicityByBlindBackTranslation({
  labelFreePngBuffer,
  targetLabel,
  allowedSynonyms = [],
  forbiddenConfusions = [],
  vlmClient,
  model,
  timeoutMs = 15000
} = {}) {
  const cleanTarget = String(targetLabel || '').trim();
  if (!cleanTarget) {
    const err = new Error('targetLabel is required');
    err.status = 400;
    throw err;
  }

  if (
    !Buffer.isBuffer(labelFreePngBuffer) ||
    !labelFreePngBuffer.length ||
    labelFreePngBuffer.length > MAX_PICTOGRAM_IMAGE_BYTES ||
    !isPngBuffer(labelFreePngBuffer)
  ) {
    const err = new Error('labelFreePngBuffer must be a valid bounded PNG buffer');
    err.status = 400;
    throw err;
  }

  if (
    !vlmClient ||
    !vlmClient.chat ||
    !vlmClient.chat.completions ||
    typeof vlmClient.chat.completions.create !== 'function'
  ) {
    const err = new Error('VLM client is not configured');
    err.status = 503;
    throw err;
  }

  const base64Png = labelFreePngBuffer.toString('base64');
  const reqBody = {
    ...(model ? { model } : {}),
    max_tokens: 32,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${base64Png}`,
              detail: 'low'
            }
          },
          {
            type: 'text',
            text: '不借助任何文字，仅凭直觉用1到3个简短中文词猜这张沟通图标表达什么（逗号分隔，不要解释）：'
          }
        ]
      }
    ]
  };

  let response;
  try {
    response = await vlmClient.chat.completions.create(reqBody, { timeout: timeoutMs });
  } catch (error) {
    const err = new Error('Iconicity blind evaluation provider failed');
    err.status = 502;
    throw err;
  }

  const content =
    response &&
    response.choices &&
    response.choices[0] &&
    response.choices[0].message &&
    response.choices[0].message.content;

  const guesses = parseBlindGuesses(content);
  const verdict = evaluateBlindIconicityGuesses({
    guesses,
    targetLabel: cleanTarget,
    allowedSynonyms,
    forbiddenConfusions
  });

  return {
    ...verdict,
    rawContent: String(content || '').trim(),
    usage: (response && response.usage) || null
  };
}

module.exports = {
  buildForbiddenConfusionsForLabel,
  evaluateBlindIconicityGuesses,
  parseBlindGuesses,
  verifyIconicityByBlindBackTranslation
};

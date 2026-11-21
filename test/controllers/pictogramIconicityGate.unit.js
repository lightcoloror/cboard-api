'use strict';

const sharp = require('sharp');
const { expect } = require('chai');

const {
  buildForbiddenConfusionsForLabel,
  evaluateBlindIconicityGuesses,
  parseBlindGuesses,
  verifyIconicityByBlindBackTranslation
} = require('../../api/helpers/pictogramIconicityGate');

describe('Pictogram iconicity blind back-translation gate (Step 3)', function () {
  it('parses Chinese punctuation, newlines, and numbered candidate guesses cleanly', function () {
    expect(parseBlindGuesses('1. 打伞，下雨\n2、防雨；撑伞')).to.deep.equal([
      '打伞',
      '下雨',
      '防雨'
    ]);
    expect(parseBlindGuesses('“助听器电池”、纽扣电池 / 换电池')).to.deep.equal([
      '助听器电池',
      '纽扣电池',
      '换电池'
    ]);
    expect(parseBlindGuesses('')).to.deep.equal([]);
  });

  it('triggers circuit breaker when negation polarity is swallowed into positive action', function () {
    const swallowed = evaluateBlindIconicityGuesses({
      guesses: ['吃药', '药瓶'],
      targetLabel: '不想吃药'
    });
    expect(swallowed.passed).to.equal(false);
    expect(swallowed.tier).to.equal('misleading_rejected');
    expect(swallowed.reason).to.equal('negation_swallowed');

    const exactTop1 = evaluateBlindIconicityGuesses({
      guesses: ['不想吃药', '拒绝吃药'],
      targetLabel: '不想吃药'
    });
    expect(exactTop1.passed).to.equal(true);
    expect(exactTop1.tier).to.equal('transparent');
    expect(exactTop1.top1Hit).to.equal(true);
    expect(exactTop1.needsLabel).to.equal(false);

    const exactTop2 = evaluateBlindIconicityGuesses({
      guesses: ['拒绝吃药', '不想吃药'],
      targetLabel: '不想吃药'
    });
    expect(exactTop2.passed).to.equal(true);
    expect(exactTop2.tier).to.equal('transparent');
    expect(exactTop2.top1Hit).to.equal(false);

    const negTranslucent = evaluateBlindIconicityGuesses({
      guesses: ['不要喝水'],
      targetLabel: '不想喝水'
    });
    expect(negTranslucent.passed).to.equal(true);
    expect(negTranslucent.tier).to.equal('translucent_needs_label');
    expect(negTranslucent.needsLabel).to.equal(true);
  });

  it('blocks high-risk carrier drift, homographs, and lexical reversals', function () {
    const bareWheelchair = evaluateBlindIconicityGuesses({
      guesses: ['轮椅', '推轮椅'],
      targetLabel: '轮椅坐垫'
    });
    expect(bareWheelchair.passed).to.equal(false);
    expect(bareWheelchair.tier).to.equal('misleading_rejected');
    expect(bareWheelchair.reason).to.equal('forbidden_confusion');

    const okCushion = evaluateBlindIconicityGuesses({
      guesses: ['轮椅坐垫', '轮椅'],
      targetLabel: '轮椅坐垫'
    });
    expect(okCushion.passed).to.equal(true);
    expect(okCushion.tier).to.equal('transparent');
    expect(okCushion.top1Hit).to.equal(true);

    const homographBox = evaluateBlindIconicityGuesses({
      guesses: ['拳击', '运动'],
      targetLabel: '眼镜盒'
    });
    expect(homographBox.passed).to.equal(false);
    expect(homographBox.reason).to.equal('forbidden_confusion');

    const cryingConfusion = evaluateBlindIconicityGuesses({
      guesses: ['流泪', '大哭'],
      targetLabel: '流泪',
      forbiddenConfusions: buildForbiddenConfusionsForLabel('流泪')
    });
    expect(cryingConfusion.passed).to.equal(false);
    expect(cryingConfusion.reason).to.equal('forbidden_confusion');
  });

  it('grades translucent shared-morpheme vs opaque unrelated guesses accurately', function () {
    const stripTranslucent = evaluateBlindIconicityGuesses({
      guesses: ['测血糖', '采血'],
      targetLabel: '血糖试纸'
    });
    expect(stripTranslucent.passed).to.equal(true);
    expect(stripTranslucent.tier).to.equal('translucent_needs_label');
    expect(stripTranslucent.needsLabel).to.equal(true);

    const opaque = evaluateBlindIconicityGuesses({
      guesses: ['西瓜', '大树'],
      targetLabel: '助听器电池'
    });
    expect(opaque.passed).to.equal(false);
    expect(opaque.tier).to.equal('opaque_rejected');
    expect(opaque.reason).to.equal('unrelated_guesses');
  });

  it('rejects non-PNG input before VLM access and validates VLM PNG payload contract', async function () {
    let vlmCalls = 0;
    const mockVlm = {
      chat: {
        completions: {
          create: async (body) => {
            vlmCalls += 1;
            const imgUrl = body.messages[0].content[0].image_url.url;
            expect(imgUrl.startsWith('data:image/png;base64,')).to.equal(true);
            return {
              choices: [{ message: { content: '打伞, 下雨, 防雨' } }],
              usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 }
            };
          }
        }
      }
    };

    let badImgErr;
    try {
      await verifyIconicityByBlindBackTranslation({
        labelFreePngBuffer: Buffer.from('not-a-png'),
        targetLabel: '打伞',
        vlmClient: mockVlm
      });
    } catch (caught) {
      badImgErr = caught;
    }
    expect(badImgErr).to.have.property('status', 400);
    expect(vlmCalls).to.equal(0);

    const validPng = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
    })
      .png()
      .toBuffer();

    const ok = await verifyIconicityByBlindBackTranslation({
      labelFreePngBuffer: validPng,
      targetLabel: '打伞',
      vlmClient: mockVlm,
      model: 'mock-vlm'
    });
    expect(vlmCalls).to.equal(1);
    expect(ok.passed).to.equal(true);
    expect(ok.tier).to.equal('transparent');
    expect(ok.top1Hit).to.equal(true);
    expect(ok.usage.total_tokens).to.equal(108);
  });
});

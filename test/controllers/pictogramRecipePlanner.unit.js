'use strict';

const express = require('express');
const request = require('supertest');
const sharp = require('sharp');
const { expect } = require('chai');

const {
  gatherOpenVocabCandidates,
  getMulberryPart,
  searchMulberryParts
} = require('../../api/helpers/mulberryPartIndex');
const {
  ALLOWED_MODIFIERS,
  composeMissingPictogram,
  planSymbolComposition
} = require('../../api/helpers/pictogramComposer');
const {
  DEFAULT_RECIPE_MAX_TOKENS,
  buildRecipePlannerMessages,
  createSymbolRecipePlanner,
  parseRecipeJson,
  shouldInvokeRecipePlanner,
  validatePlannedRecipe
} = require('../../api/helpers/pictogramRecipePlanner');
const {
  createDefaultPictogramCompositionRuntime
} = require('../../api/helpers/pictogramCompositionRuntime');
const {
  createPictogramCompositionRouter
} = require('../../api/helpers/pictogramCompositionRouter');
const { isGif89aBuffer } = require('../../api/helpers/pictogramImage');

describe('Open-vocabulary recall, modifier operators & ~75-Token SymbolRecipe planner (Step 5)', function () {
  this.timeout(25000);

  it('applies newly curated Crowdin care-vocabulary fixes and shared-bigram lexical recall safely', function () {
    const armChair = getMulberryPart('arm_chair');
    expect(armChair.zh).to.equal('扶手椅');
    expect(searchMulberryParts('手枪', { limit: 12 }).candidates.map(c => c.file)).to.not.include('arm_chair.svg');

    expect(searchMulberryParts('键值', { limit: 10 }).candidates.map(c => c.file)).to.not.include('kettle.svg');
    expect(searchMulberryParts('水壶', { limit: 5 }).candidates[0].partId).to.equal('kettle');

    expect(searchMulberryParts('擦桌子', { limit: 5 }).candidates[0].partId).to.equal('wipe_table_to');
    expect(searchMulberryParts('剪指甲', { limit: 5 }).candidates[0].partId).to.equal('clip_nails_to');
    expect(searchMulberryParts('换尿不湿', { limit: 5 }).candidates[0].partId).to.equal('change_nappy_to');
    expect(searchMulberryParts('测体温', { limit: 5 }).candidates[0].partId).to.equal('thermometer');
    expect(searchMulberryParts('开灯', { limit: 5 }).candidates[0].partId).to.equal('turn_on_light_switch_to');
    expect(searchMulberryParts('洗头发', { limit: 5 }).candidates[0].partId).to.equal('shampoo_hair_to');

    // Shared 2-char CJK stem overlap rescues morphological variants without disturbing curated precision
    const tvStem = searchMulberryParts('打开电视', { limit: 5 });
    expect(tvStem.candidates.some(c => c.matchReason === 'shared_stem_zh' || c.matchReason === 'subword_zh')).to.equal(true);
  });

  it('deterministically resolves exact everyday care verbs and prefix modifiers into valid animated micro-GIFs at 0 Tokens', async function () {
    const exactPhrases = [
      { label: '换尿不湿', expectedHead: 'change_nappy_to' },
      { label: '剪指甲', expectedHead: 'clip_nails_to' },
      { label: '擦桌子', expectedHead: 'wipe_table_to' },
      { label: '测体温', expectedHead: 'thermometer' },
      { label: '洗头发', expectedHead: 'shampoo_hair_to' },
      { label: '开灯', expectedHead: 'turn_on_light_switch_to' }
    ];

    for (const item of exactPhrases) {
      const recipe = planSymbolComposition(item.label);
      expect(recipe.ruleId).to.equal('rule_exact_library_part');
      expect(recipe.head).to.equal(item.expectedHead);
      expect(recipe.needsRegenFallback).to.equal(false);
      expect(shouldInvokeRecipePlanner(recipe)).to.equal(false);
    }

    const modCases = [
      { label: '找遥控器', head: 'remote_control', modifier: 'find' },
      { label: '拉窗帘', head: 'curtains', modifier: 'close' },
      { label: '换眼镜', head: 'glasses', modifier: 'replace' }
    ];
    for (const mc of modCases) {
      expect(ALLOWED_MODIFIERS).to.include(mc.modifier);
      const out = await composeMissingPictogram(mc.label, { format: 'all' });
      expect(out.recipe.op).to.equal('modify_attr');
      expect(out.recipe.head).to.equal(mc.head);
      expect(out.recipe.modifier).to.equal(mc.modifier);
      expect(shouldInvokeRecipePlanner(out.recipe)).to.equal(false);
      expect(out.svg).to.include('<svg').and.include(mc.label);
      expect(isGif89aBuffer(out.gifBuffer)).to.equal(true);
      expect(out.gifBuffer.length).to.be.lessThan(60 * 1024);

      const meta = await sharp(out.gifBuffer, { animated: true }).metadata();
      expect(meta.pages).to.be.at.least(2);
      expect(meta.width).to.equal(300);
    }
  });

  it('plans novel composite concepts via ultra-thin ~75-Token SymbolRecipe JSON with privacy anonymization', async function () {
    let capturedRequest = null;
    const fakeLlmClient = {
      chat: {
        completions: {
          async create(params) {
            capturedRequest = params;
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      op: 'act_with',
                      head: 'kettle',
                      context: 'mug_2',
                      modifier: 'hot',
                      needsRegen: false,
                      regenHint: ''
                    })
                  }
                }
              ],
              usage: { prompt_tokens: 245, completion_tokens: 46, total_tokens: 291 }
            };
          }
        }
      }
    };

    const det = planSymbolComposition('倒热水');
    expect(shouldInvokeRecipePlanner(det)).to.equal(true);

    // Inject fake BGE embedding vector so gatherOpenVocabCandidates includes mug_2 + kettle naturally
    const planner = createSymbolRecipePlanner({
      llmClient: fakeLlmClient,
      model: 'gpt-4o-mini',
      candidateLimit: 10
    });

    // Test candidate gathering & message builder directly
    const gathered = gatherOpenVocabCandidates('水壶 杯子 热水', { limit: 10 });
    const ids = new Set(gathered.candidates.map(c => c.partId));
    expect(ids.has('kettle')).to.equal(true);
    expect(ids.has('mug_2')).to.equal(true);

    const msgs = buildRecipePlannerMessages({
      sanitizedLabel: '给PERSON_1倒热水',
      candidates: gathered.candidates
    });
    expect(msgs[1].content).to.include('PERSON_1');
    expect(msgs[1].content).to.not.include('张阿姨');

    // Run end-to-end planner on '给热水壶倒热水杯子' so both kettle and mug_2 appear in top lexical candidates
    const planned = await planner.planOpenVocabRecipe({
      label: '倒热水',
      sanitizedLabel: '水壶 热水 杯子',
      deterministicRecipe: det
    });

    expect(capturedRequest).to.include({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: DEFAULT_RECIPE_MAX_TOKENS
    });
    expect(capturedRequest.max_tokens).to.be.at.most(120);
    expect(planned.usedLlm).to.equal(true);
    expect(planned.recipe.op).to.equal('act_with');
    expect(planned.recipe.head).to.equal('kettle');
    expect(planned.recipe.context).to.equal('mug_2');
    expect(planned.recipe.modifier).to.equal('hot');
    expect(planned.usage.completion_tokens).to.equal(46);

    const composed = await composeMissingPictogram('倒热水', {
      recipe: planned.recipe,
      format: 'all'
    });
    expect(isGif89aBuffer(composed.gifBuffer)).to.equal(true);
    expect(composed.gifBuffer.length).to.be.lessThan(60 * 1024);
    expect(composed.svg).to.include('#DC2626'); // red hot steam badge
  });

  it('blocks hallucinated or quarantined partIds and enforces hard negation polarity guard', function () {
    const allowed = new Set(['jacket', 'kettle', 'beansprouts']);

    expect(parseRecipeJson('```json\n{"op":"single_part","head":"jacket"}\n```')).to.deep.equal({
      op: 'single_part',
      head: 'jacket'
    });
    expect(parseRecipeJson('not json at all')).to.equal(null);

    const hallucinated = validatePlannedRecipe({
      rawPlan: { op: 'single_part', head: 'non_existent_part_xyz', modifier: null },
      label: '未知部件',
      allowedCandidateIds: allowed
    });
    expect(hallucinated).to.deep.equal({ ok: false, reason: 'hallucinated_or_disallowed_part' });

    const quarantined = validatePlannedRecipe({
      rawPlan: { op: 'single_part', head: 'beansprouts' },
      label: '豆芽',
      allowedCandidateIds: allowed
    });
    expect(quarantined).to.deep.equal({ ok: false, reason: 'hallucinated_or_disallowed_part' });

    // Negation polarity guard: even if LLM outputs positive 'modify_attr' for '不想穿外套', force 'negate_thought'
    const negGuarded = validatePlannedRecipe({
      rawPlan: { op: 'modify_attr', head: 'jacket', modifier: 'open' },
      label: '不想穿外套',
      allowedCandidateIds: allowed
    });
    expect(negGuarded.ok).to.equal(true);
    expect(negGuarded.negationEnforced).to.equal(true);
    expect(negGuarded.recipe.op).to.equal('negate_thought');
    expect(negGuarded.recipe.head).to.equal('jacket');
  });

  it('wires SymbolRecipe planner into two-tier pipeline & router without calling LLM for strong deterministic hits', async function () {
    let llmCalls = 0;
    let lastUserPrompt = '';
    const mockLlmClient = {
      chat: {
        completions: {
          async create(params) {
            llmCalls += 1;
            lastUserPrompt = params.messages[1].content;
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      op: 'act_with',
                      head: 'kettle',
                      context: 'mug_2',
                      modifier: 'hot',
                      needsRegen: false
                    })
                  }
                }
              ],
              usage: { prompt_tokens: 210, completion_tokens: 42, total_tokens: 252 }
            };
          }
        }
      }
    };

    // Provide dummy normalized vector aligned to mug_2/kettle just to confirm embedQuery hook works cleanly
    const embedCalls = [];
    const runtime = createDefaultPictogramCompositionRuntime({
      cacheDbPath: ':memory:',
      recipeLlmClient: mockLlmClient,
      async embedQuery(text) {
        embedCalls.push(text);
        return null;
      }
    });

    const app = express();
    app.use(
      '/pictograms/v2',
      createPictogramCompositionRouter({
        pipeline: runtime.pipeline,
        cache: runtime.cache,
        enabled: true,
        authenticate: async (req, hdr) => {
          if (hdr !== 'Bearer ok-token') return false;
          req.user = { id: 'caregiver-1' };
          return true;
        },
        isRecipePlannerConfigured: runtime.isRecipePlannerConfigured
      })
    );

    try {
      const health = await request(app).get('/pictograms/v2/health');
      expect(health.status).to.equal(200);
      expect(health.body.recipePlannerConfigured).to.equal(true);

      // Curated hit '眼镜盒' skips LLM completely (0 extra tokens!)
      const curatedRes = await request(app)
        .post('/pictograms/v2/resolve')
        .set('Authorization', 'Bearer ok-token')
        .send({ label: '眼镜盒' });
      expect(curatedRes.status).to.equal(200);
      expect(llmCalls).to.equal(0);
      expect(curatedRes.body.planner.skippedReason).to.equal('deterministic_sufficient');

      // Open-vocab composite query with registered person name anonymizes PERSON_1 before LLM prompt
      const openRes = await request(app)
        .post('/pictograms/v2/resolve')
        .set('Authorization', 'Bearer ok-token')
        .send({
          label: '给张阿姨拿热水壶和杯子',
          registeredPersonNames: ['张阿姨']
        });
      expect(openRes.status).to.equal(200);
      expect(llmCalls).to.equal(1);
      expect(embedCalls).to.have.lengthOf(1);
      expect(embedCalls[0]).to.equal('给PERSON_1拿热水壶和杯子');
      expect(lastUserPrompt).to.include('PERSON_1');
      expect(lastUserPrompt).to.not.include('张阿姨');
      expect(openRes.body.planner.usedLlm).to.equal(true);
      expect(openRes.body.recipe.op).to.equal('act_with');
      expect(openRes.body.mediaType).to.equal('gif');
      expect(isGif89aBuffer(Buffer.from(openRes.body.imageBase64, 'base64'))).to.equal(true);
    } finally {
      runtime.close();
    }
  });
});

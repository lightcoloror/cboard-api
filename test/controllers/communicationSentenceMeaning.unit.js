'use strict';
const assert = require('assert').strict;
const { createCommunicationAi } = require('../../api/helpers/communicationAi');
const { filterFaithfulExpressionCandidates } = require('../../api/helpers/phraseSuggestions');

describe('Sentence meaning boundary with actual provider adapter', function() {
  function fixture(content) {
    const calls = [], usage = [];
    const ai = createCommunicationAi({
      client: { chat: { completions: { create: async (body, options) => {
        calls.push({ body, options });
        return { choices: [{ message: { content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } };
      } } } }, onUsage: event => usage.push(event)
    });
    return { ai, calls, usage };
  }

  it('rejects the recorded pain-degree/time drift without another model call or lost usage', async function() {
    const f = fixture('我好痛。\n我现在很痛。\n我痛死了。');
    await assert.rejects(f.ai.generateSentenceCandidates({ pictogramLabels: ['我', '痛'] }),
      error => error.code === 'AI_SENTENCE_MEANING_MISMATCH' && error.status === 502);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].options, { maxRetries: 0 });
    assert.equal(f.usage.length, 1);
    assert.equal(f.usage[0].usage.total_tokens, 40);
    assert(f.calls[0].body.messages[0].content.includes('不为凑数改意'));
  });

  it('returns fewer valid alternatives rather than padding with invented facts', async function() {
    const f = fixture('我好痛。\n我痛。\n我现在很痛。');
    const result = await f.ai.generateSentenceCandidates({ pictogramLabels: ['我', '痛'] });
    assert.deepEqual(result.candidates, ['我痛。']);
    assert.equal(f.calls.length, 1);
  });

  it('does not hide unsupported trailing content by truncating the response to 120 characters', async function() {
    const labels = Array(5).fill('水'.repeat(24));
    const f = fixture(labels.join('') + '现在很痛。');
    await assert.rejects(f.ai.generateSentenceCandidates({ pictogramLabels: labels }),
      error => error.code === 'AI_SENTENCE_INCOMPLETE_RESPONSE');
    assert.equal(f.calls.length, 1); assert.equal(f.usage.length, 1);
  });

  it('keeps anonymous people, order and repeated mentions while screening the provider output', async function() {
    const f = fixture('⟦P2⟧叫⟦P1⟧找⟦P1⟧。\n⟦P1⟧叫⟦P2⟧找⟦P1⟧。\n⟦P1⟧叫⟦P2⟧找他。');
    const result = await f.ai.generateSentenceCandidates({ pictogramLabels: ['⟦P1⟧', '叫', '⟦P2⟧', '找', '⟦P1⟧'] });
    assert.deepEqual(result.candidates, ['⟦P1⟧叫⟦P2⟧找⟦P1⟧。']);
    assert.equal(f.usage.length, 1);
  });

  it('does not allow scene or prior feedback to add time or degree', async function() {
    const f = fixture('我现在很痛。\n我痛。');
    const result = await f.ai.generateSentenceCandidates({ pictogramLabels: ['我', '痛'],
      context: { scene: 'hospital', recentSentences: ['现在很痛'], candidateFeedback: [{ sentence: '我好痛', feedback: 'up' }] } });
    assert.deepEqual(result.candidates, ['我痛。']);
  });

  it('uses the vendored shared contract for negation, quantity and ordered roles', function() {
    assert.deepEqual(filterFaithfulExpressionCandidates(['我', '今晚', '不', '回家', '吃饭'],
      ['我今晚回家不吃饭。', '我不回家吃饭。', '我今晚不回家吃饭。']), ['我今晚不回家吃饭。']);
    assert.deepEqual(filterFaithfulExpressionCandidates(['请', '给', '我', '两杯', '水'],
      ['请给我水。', '请给我一杯水。', '请给我两杯水。']), ['请给我两杯水。']);
  });
});

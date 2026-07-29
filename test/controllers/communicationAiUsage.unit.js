'use strict';

const chai = require('chai');
const {
  COMMUNICATION_AI_OPERATIONS,
  createCommunicationAiUsageService,
  normalizeCommunicationAiUsage,
  settleAndRecordCommunicationAiUsage,
  summarizeCommunicationAiUsage
} = require('../../api/helpers/communicationAiUsage');

const expect = chai.expect;

function createQuery(result) {
  return {
    exec: async () => result,
    lean() {
      return this;
    }
  };
}

describe('Communication AI usage ledger', function() {
  it('recognizes pictogram generation as a model-backed operation', function() {
    expect(COMMUNICATION_AI_OPERATIONS).to.include('pictogram-generation');
  });

  it('normalizes provider-reported usage without estimating missing tokens', function() {
    expect(
      normalizeCommunicationAiUsage({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 12
      })
    ).to.deep.equal({
      reported: true,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 12
    });
    expect(
      normalizeCommunicationAiUsage({
        input_tokens: 7,
        output_tokens: 3
      })
    ).to.deep.equal({
      reported: true,
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10
    });
    expect(normalizeCommunicationAiUsage(null)).to.deep.equal({
      reported: false,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    });
    expect(
      normalizeCommunicationAiUsage({ prompt_tokens: 'invalid' })
    ).to.deep.equal({
      reported: false,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    });
  });

  it('atomically increments a monthly per-operation aggregate', async function() {
    let captured;
    const model = {
      findOneAndUpdate(filter, update, options) {
        captured = { filter, update, options };
        return createQuery({});
      }
    };
    const service = createCommunicationAiUsageService({
      model,
      now: () => new Date('2026-07-22T01:02:03.000Z')
    });

    const result = await service.recordUsage({
      userId: '507f1f77bcf86cd799439011',
      provider: 'azure-openai',
      model: 'gpt-4o-mini',
      operation: 'resegment',
      usage: {
        prompt_tokens: 30,
        completion_tokens: 8,
        total_tokens: 38
      }
    });

    expect(captured.filter).to.deep.equal({
      user: '507f1f77bcf86cd799439011',
      month: '2026-07',
      provider: 'azure-openai',
      model: 'gpt-4o-mini',
      operation: 'resegment'
    });
    expect(captured.update.$inc).to.deep.equal({
      requestCount: 1,
      reportedRequestCount: 1,
      unreportedRequestCount: 0,
      promptTokens: 30,
      completionTokens: 8,
      totalTokens: 38
    });
    expect(captured.options).to.include({ upsert: true, new: true });
    expect(result).to.deep.equal({
      month: '2026-07',
      reported: true,
      promptTokens: 30,
      completionTokens: 8,
      totalTokens: 38
    });
  });

  it('retries a duplicate upsert race without losing the increment', async function() {
    const optionsSeen = [];
    const model = {
      findOneAndUpdate(filter, update, options) {
        optionsSeen.push(options);
        if (optionsSeen.length === 1) {
          return createQuery(
            Promise.reject(
              Object.assign(new Error('race'), {
                code: 11000
              })
            )
          );
        }
        return createQuery({});
      }
    };
    const service = createCommunicationAiUsageService({ model });

    await service.recordUsage({
      userId: '507f1f77bcf86cd799439011',
      provider: 'openai-compatible',
      model: 'model',
      operation: 'ocr',
      usage: null
    });

    expect(optionsSeen.map(options => options.upsert)).to.deep.equal([
      true,
      false
    ]);
  });

  it('returns content-free totals and exposes unreported provider calls', async function() {
    const summary = summarizeCommunicationAiUsage(
      [
        {
          provider: 'openai-compatible',
          model: 'model-a',
          operation: 'sentence-candidates',
          requestCount: 2,
          reportedRequestCount: 1,
          unreportedRequestCount: 1,
          promptTokens: 11,
          completionTokens: 4,
          totalTokens: 15,
          prompt: 'must not leak'
        },
        {
          provider: 'azure-openai',
          model: 'model-b',
          operation: 'resegment',
          requestCount: 1,
          reportedRequestCount: 1,
          unreportedRequestCount: 0,
          promptTokens: 7,
          completionTokens: 2,
          totalTokens: 9
        }
      ],
      '2026-07'
    );

    expect(summary).to.include({
      month: '2026-07',
      requestCount: 3,
      reportedRequestCount: 2,
      unreportedRequestCount: 1,
      promptTokens: 18,
      completionTokens: 6,
      totalTokens: 24,
      providerReported: false
    });
    expect(JSON.stringify(summary)).not.to.include('must not leak');
  });

  it('queries only the authenticated user and current UTC month', async function() {
    let filter;
    const model = {
      find(value) {
        filter = value;
        return createQuery([]);
      }
    };
    const service = createCommunicationAiUsageService({
      model,
      now: () => new Date('2026-01-31T23:59:59.000Z')
    });

    const result = await service.getMonthlyUsage({ userId: 'user-id' });

    expect(filter).to.deep.equal({ user: 'user-id', month: '2026-01' });
    expect(result).to.include({
      month: '2026-01',
      requestCount: 0,
      totalTokens: 0,
      providerReported: false
    });
  });

  it('settles the quota reservation before recording provider usage', async function() {
    const events = [];
    const reservation = { tokens: 4096 };
    const usage = {
      prompt_tokens: 20,
      completion_tokens: 5,
      total_tokens: 25
    };

    await settleAndRecordCommunicationAiUsage({
      req: {
        user: { id: 'user-id' },
        communicationAiTokenQuotaReservation: reservation,
        communicationAiTokenQuotaService: {
          async settleReservation(value, reportedUsage) {
            events.push([
              'quota',
              value.tokens,
              reportedUsage.total_tokens
            ]);
          }
        }
      },
      provider: {
        provider: 'openai-compatible',
        model: 'configured-model'
      },
      event: {
        operation: 'sentence-candidates',
        model: 'reported-model',
        usage
      },
      recordUsageImpl: async input => {
        events.push(['ledger', input]);
      }
    });

    expect(events).to.deep.equal([
      ['quota', 4096, 25],
      [
        'ledger',
        {
          userId: 'user-id',
          provider: 'openai-compatible',
          model: 'reported-model',
          operation: 'sentence-candidates',
          usage
        }
      ]
    ]);
  });
});

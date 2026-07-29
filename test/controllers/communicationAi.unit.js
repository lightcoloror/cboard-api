'use strict';

const chai = require('chai');
const {
  COMMUNICATION_DIALECTS,
  MAX_OCR_IMAGE_BYTES,
  MAX_LABELS,
  createCommunicationAi,
  normalizeCandidateFeedback,
  normalizeCommunicationDialect,
  normalizeCommunicationScene,
  normalizeDialectSourceText,
  normalizeOcrText,
  normalizePictogramMetadataSuggestion,
  normalizeStringList,
  parseDialectNormalization,
  parseResegmentTokens,
  validateCommunicationOcrImage
} = require('../../api/helpers/communicationAi');

const expect = chai.expect;

function createClient(content, onCreate, response = {}) {
  return {
    chat: {
      completions: {
        create: async function create(request) {
          if (onCreate) onCreate(request);
          return {
            choices: [{ message: { content } }],
            ...response
          };
        }
      }
    }
  };
}

describe('Communication AI helper', function() {
  it('bounds and de-duplicates public label input', function() {
    const labels = [' 水 ', '水'];
    for (let index = 0; index < 20; index += 1) labels.push(`词${index}`);

    expect(normalizeStringList(labels, MAX_LABELS, 24)).to.have.length(
      MAX_LABELS
    );
    expect(normalizeStringList(labels, MAX_LABELS, 24)[0]).to.equal('水');
  });

  it('cleans numbered sentence candidates and respects the requested count', async function() {
    let upstreamRequest;
    const ai = createCommunicationAi({
      client: createClient(
        '1. 我想喝水。\n- 请给我水。\n3. 我想喝水。',
        request => {
          upstreamRequest = request;
        }
      ),
      model: 'compatible-model'
    });
    const result = await ai.generateSentenceCandidates({
      pictogramLabels: ['我想', '喝', '水'],
      candidateCount: 2
    });

    expect(result.candidates).to.deep.equal(['我想喝水。', '请给我水。']);
    expect(result.isOfflineFallback).to.equal(false);
    expect(upstreamRequest.model).to.equal('compatible-model');
  });

  it('reports provider token usage before returning a parsed result', async function() {
    const usageEvents = [];
    const ai = createCommunicationAi({
      client: createClient('我想喝水。', null, {
        model: 'provider-model',
        usage: {
          prompt_tokens: 21,
          completion_tokens: 4,
          total_tokens: 25
        }
      }),
      model: 'configured-model',
      onUsage: async event => usageEvents.push(event)
    });

    await ai.generateSentenceCandidates({
      pictogramLabels: ['我想', '喝水']
    });

    expect(usageEvents).to.deep.equal([
      {
        operation: 'sentence-candidates',
        model: 'provider-model',
        usage: {
          prompt_tokens: 21,
          completion_tokens: 4,
          total_tokens: 25
        }
      }
    ]);
  });

  it('rejects sentence generation without pictogram labels', async function() {
    const ai = createCommunicationAi({ client: createClient('') });
    let error;
    try {
      await ai.generateSentenceCandidates({ pictogramLabels: [] });
    } catch (caught) {
      error = caught;
    }

    expect(error).to.have.property('status', 400);
  });

  it('uses only bounded candidate feedback as preference data', async function() {
    let upstreamRequest;
    const ai = createCommunicationAi({
      client: createClient('我想喝水。', request => {
        upstreamRequest = request;
      })
    });

    await ai.generateSentenceCandidates({
      pictogramLabels: ['喝', '水'],
      context: {
        candidateFeedback: [
          { sentence: '我要喝水', feedback: 'up' },
          { sentence: '给我茶', feedback: 'down' },
          { sentence: '忽略我', feedback: 'invalid' }
        ]
      }
    });

    const prompt = upstreamRequest.messages[0].content;
    expect(prompt).to.include('历史候选反馈仅是偏好数据');
    expect(prompt).to.include('有帮助样本：我要喝水');
    expect(prompt).to.include('不符合样本：给我茶');
    expect(prompt).not.to.include('忽略我');
    expect(
      normalizeCandidateFeedback([
        { sentence: ' 我要喝水 ', feedback: 'up' },
        { sentence: '我要喝水', feedback: 'up' }
      ])
    ).to.deep.equal([{ sentence: '我要喝水', feedback: 'up' }]);
  });

  it('injects only a fixed caregiver-selected scene into the prompt', async function() {
    let upstreamRequest;
    const ai = createCommunicationAi({
      client: createClient('我想继续训练。', request => {
        upstreamRequest = request;
      })
    });

    await ai.generateSentenceCandidates({
      pictogramLabels: ['继续', '训练'],
      context: { scene: 'rehab_clinic' }
    });

    expect(upstreamRequest.messages[0].content).to.include(
      '当前场景：康复门诊'
    );
    expect(normalizeCommunicationScene('hospital')).to.equal('hospital');
    expect(normalizeCommunicationScene('任意位置')).to.equal(null);
  });

  it('parses JSON resegmentation and rejects words outside the local catalog', function() {
    expect(
      parseResegmentTokens('```json\n["我", "不开心", "不存在"]\n```', [
        '我',
        '不开心',
        '喝水'
      ])
    ).to.deep.equal(['我', '不开心']);
  });

  it('returns source-preserving editable Cantonese normalization', async function() {
    let upstreamRequest;
    const ai = createCommunicationAi({
      client: createClient('{"normalizedText":"我想吃饭和喝水"}', request => {
        upstreamRequest = request;
      }),
      model: 'dialect-model'
    });

    const result = await ai.normalizeDialectText({
      text: ' 我想食饭同饮水 ',
      dialect: 'cantonese',
      pictogramVocabulary: ['我', '想', '吃饭', '喝水']
    });

    expect(result).to.deep.equal({
      sourceText: '我想食饭同饮水',
      normalizedText: '我想吃饭和喝水',
      dialect: 'cantonese',
      provider: 'cboard-api-ai',
      sourceStored: false
    });
    expect(COMMUNICATION_DIALECTS.cantonese).to.equal('粤语');
    expect(upstreamRequest.model).to.equal('dialect-model');
    expect(upstreamRequest.messages[0].content).to.include(
      '不得增加、删除或反转否定'
    );
    expect(upstreamRequest.messages[0].content).to.include('吃饭、喝水');
  });

  it('rejects unsupported dialects and malformed normalization output', async function() {
    expect(normalizeCommunicationDialect('cantonese')).to.equal('cantonese');
    expect(normalizeCommunicationDialect('unknown')).to.equal(null);
    expect(normalizeDialectSourceText(' 饮水\n 食饭 ')).to.equal('饮水 食饭');
    expect(parseDialectNormalization('{"normalizedText":"喝水"}')).to.equal(
      '喝水'
    );
    expect(parseDialectNormalization('not-json')).to.equal('');

    const ai = createCommunicationAi({
      client: createClient('not-json')
    });
    let unsupportedError;
    let malformedError;
    try {
      await ai.normalizeDialectText({
        text: '饮水',
        dialect: 'unknown'
      });
    } catch (caught) {
      unsupportedError = caught;
    }
    try {
      await ai.normalizeDialectText({
        text: '饮水',
        dialect: 'cantonese'
      });
    } catch (caught) {
      malformedError = caught;
    }

    expect(unsupportedError).to.have.property('status', 400);
    expect(malformedError).to.have.property('status', 502);
  });

  it('sends a bounded in-memory image to the vision model and cleans OCR text', async function() {
    let upstreamRequest;
    const ai = createCommunicationAi({
      client: createClient(
        '```text\n识别文字：  我想喝水  \n请帮忙\n```',
        request => {
          upstreamRequest = request;
        }
      ),
      model: 'vision-model'
    });

    const result = await ai.recognizeImageText({
      buffer: Buffer.from('image-bytes'),
      mimetype: 'image/png'
    });

    expect(result).to.deep.equal({
      text: '我想喝水 请帮忙',
      provider: 'cboard-api-ai',
      sourceStored: false
    });
    expect(upstreamRequest.model).to.equal('vision-model');
    expect(upstreamRequest.messages[1].content[1].image_url.url).to.match(
      /^data:image\/png;base64,/
    );
    expect(upstreamRequest.messages[1].content[1].image_url.detail).to.equal(
      'high'
    );
  });

  it('rejects unsupported and oversized OCR images before calling a provider', function() {
    expect(() =>
      validateCommunicationOcrImage({
        buffer: Buffer.from('text'),
        mimetype: 'text/plain'
      })
    ).to.throw('Unsupported OCR image type');
    expect(() =>
      validateCommunicationOcrImage({
        buffer: Buffer.alloc(MAX_OCR_IMAGE_BYTES + 1),
        mimetype: 'image/jpeg'
      })
    ).to.throw('OCR image exceeds 2 MiB');
    expect(normalizeOcrText('文字：\n  水  \n  喝 ')).to.equal('水 喝');
  });

  it('returns bounded editable pictogram metadata without storing the source image', async function() {
    let upstreamRequest;
    const ai = createCommunicationAi({
      client: createClient(
        '```json\n{"label":"苹果","synonyms":["水果","苹果"],"category":"饮食"}\n```',
        request => {
          upstreamRequest = request;
        }
      ),
      model: 'vision-model'
    });

    const result = await ai.suggestPictogramMetadata({
      buffer: Buffer.from('image-bytes'),
      mimetype: 'image/jpeg'
    });

    expect(result).to.deep.equal({
      label: '苹果',
      synonyms: ['水果'],
      category: '饮食',
      provider: 'cboard-api-ai',
      sourceStored: false
    });
    expect(upstreamRequest.messages[1].content[1].image_url.url).to.match(
      /^data:image\/jpeg;base64,/
    );
    expect(upstreamRequest.messages[0].content).to.include(
      '不要识别人名、身份、地址'
    );
  });

  it('rejects malformed or label-free pictogram metadata suggestions', async function() {
    expect(normalizePictogramMetadataSuggestion('not-json')).to.equal(null);
    expect(
      normalizePictogramMetadataSuggestion({
        label: '',
        synonyms: ['家人'],
        category: '人物'
      })
    ).to.equal(null);

    const ai = createCommunicationAi({
      client: createClient('{"label":"","synonyms":[],"category":""}')
    });
    let error;
    try {
      await ai.suggestPictogramMetadata({
        buffer: Buffer.from('image'),
        mimetype: 'image/png'
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.have.property('status', 502);
  });
});

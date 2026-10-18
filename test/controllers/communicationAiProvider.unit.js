'use strict';

const chai = require('chai');
const {
  createCommunicationAiProvider,
  normalizeTimeout,
  resolveResegmentRequestOptions,
  resolveSentenceRequestOptions,
  resolveCommunicationAiConfig
} = require('../../api/helpers/communicationAiProvider');

const expect = chai.expect;

function createSdkHarness() {
  const calls = [];

  class FakeOpenAI {
    constructor(options) {
      calls.push({ kind: 'openai-compatible', options });
    }
  }

  class FakeAzureOpenAI {
    constructor(options) {
      calls.push({ kind: 'azure-openai', options });
    }
  }

  return {
    calls,
    sdk: {
      OpenAI: FakeOpenAI,
      AzureOpenAI: FakeAzureOpenAI
    }
  };
}

describe('Communication AI provider configuration', function () {
  it('reuses sentence provider limits without inheriting the tokens JSON schema', function () {
    const inherited = JSON.stringify({ enable_thinking: false, max_tokens: 2048, response_format: 'json_schema' });
    expect(resolveSentenceRequestOptions(undefined, inherited)).to.deep.equal({
      enable_thinking: false, max_tokens: 2048, response_format: { type: 'text' }
    });
    expect(resolveSentenceRequestOptions('{"max_tokens":512,"thinking_mode":"disabled"}', inherited))
      .to.deep.equal({ max_tokens: 512, thinking: { type: 'disabled' } });
    expect(resolveSentenceRequestOptions(undefined, undefined)).to.deep.equal({});
    for (const raw of ['{"model":"secret"}', '{"response_format":"json_object"}', 'null']) {
      expect(() => resolveSentenceRequestOptions(raw, inherited)).to.throw('Invalid server sentence request options')
        .with.property('code', 'AI_SENTENCE_CONFIGURATION_INVALID');
    }
  });
  it('adapts bounded server options without accepting model or message overrides', function () {
    expect(resolveResegmentRequestOptions(undefined)).to.deep.equal({});
    expect(resolveResegmentRequestOptions('')).to.deep.equal({});
    expect(resolveResegmentRequestOptions(JSON.stringify({
      enable_thinking: false, max_tokens: 2048, response_format: 'json_object'
    }))).to.deep.equal({ enable_thinking: false, max_tokens: 2048,
      response_format: { type: 'json_object' } });
    expect(resolveResegmentRequestOptions('{"thinking_mode":"disabled","response_format":"text"}'))
      .to.deep.equal({ thinking: { type: 'disabled' }, response_format: { type: 'text' } });
    const schema = resolveResegmentRequestOptions('{"response_format":"json_schema"}').response_format;
    expect(schema.json_schema.schema.required).to.deep.equal(['tokens']);
    expect(schema.json_schema.schema.additionalProperties).to.equal(false);
    expect(resolveResegmentRequestOptions('{"reasoning_effort":"high","thinking_budget":2048}'))
      .to.deep.equal({ reasoning_effort: 'high', thinking_budget: 2048 });
  });

  it('fails closed on malformed or unbounded options without echoing their contents', function () {
    const invalid = ['bad-secret', 'null', '[]', '{"model":"bad-secret"}',
      '{"messages":[]}', '{"baseURL":"https://bad-secret"}', '{"stream":true}',
      '{"max_tokens":8193}', '{"max_tokens":"2048"}', '{"max_tokens":1.5}',
      '{"thinking_budget":127}', '{"enable_thinking":"false"}',
      '{"reasoning_effort":"unlimited"}', '{"thinking_mode":"auto"}',
      '{"enable_thinking":false,"thinking_mode":"disabled"}',
      '{"enable_thinking":false,"reasoning_effort":"high"}',
      '{"thinking_mode":"disabled","thinking_budget":2048}',
      '{"response_format":{"type":"json_object"}}'];
    invalid.forEach(value => {
      try { resolveResegmentRequestOptions(value); throw new Error('expected rejection'); }
      catch (error) {
        expect(error.code).to.equal('AI_RESEGMENT_CONFIGURATION_INVALID');
        expect(error.status).to.equal(503);
        expect(error.message).not.to.include('bad-secret');
      }
    });
  });

  it('restores PicInterpreter OpenAI-compatible environment variables', function () {
    const harness = createSdkHarness();
    const provider = createCommunicationAiProvider({
      env: {
        AI_API_KEY: 'server-secret',
        AI_BASE_URL: 'https://compatible.example/v1/',
        AI_MODEL: 'compatible-model',
        AI_REQUEST_TIMEOUT_MS: '9000'
      },
      sdk: harness.sdk
    });

    expect(provider).to.include({
      provider: 'openai-compatible',
      model: 'compatible-model',
      baseUrl: 'https://compatible.example/v1',
      timeoutMs: 9000
    });
    expect(provider).not.to.have.property('apiKey');
    expect(harness.calls[0]).to.deep.equal({
      kind: 'openai-compatible',
      options: {
        apiKey: 'server-secret',
        timeout: 9000,
        maxRetries: 1,
        baseURL: 'https://compatible.example/v1'
      }
    });
  });

  it('keeps the existing Azure OpenAI configuration as a fallback', function () {
    const harness = createSdkHarness();
    const provider = createCommunicationAiProvider({
      env: {
        AZURE_OPENAI_API_KEY: 'azure-secret',
        AZURE_OPENAI_ENDPOINT: 'https://azure.example/',
        AZURE_OPENAI_API_VERSION: '2024-06-01',
        AZURE_OPENAI_DEPLOYMENT: 'aac-model'
      },
      sdk: harness.sdk
    });

    expect(provider).to.include({
      provider: 'azure-openai',
      model: 'aac-model',
      baseUrl: 'https://azure.example'
    });
    expect(harness.calls[0].kind).to.equal('azure-openai');
    expect(harness.calls[0].options).to.include({
      apiKey: 'azure-secret',
      endpoint: 'https://azure.example',
      apiVersion: '2024-06-01',
      deployment: 'aac-model'
    });
  });

  it('prefers the generic provider and rejects missing or invalid configuration', function () {
    expect(
      resolveCommunicationAiConfig({
        AI_API_KEY: 'generic',
        AI_MODEL: 'generic-model',
        AZURE_OPENAI_API_KEY: 'azure',
        AZURE_OPENAI_ENDPOINT: 'https://azure.example'
      })
    ).to.include({
      kind: 'openai-compatible',
      model: 'generic-model'
    });
    expect(resolveCommunicationAiConfig({})).to.equal(null);
    expect(
      resolveCommunicationAiConfig({
        AI_API_KEY: 'generic',
        AI_BASE_URL: 'not-a-url'
      })
    ).to.equal(null);
  });

  it('bounds upstream timeouts to a safe range', function () {
    expect(normalizeTimeout('50')).to.equal(1000);
    expect(normalizeTimeout('9000')).to.equal(9000);
    expect(normalizeTimeout('999999')).to.equal(60000);
    expect(normalizeTimeout('invalid')).to.equal(15000);
  });
});

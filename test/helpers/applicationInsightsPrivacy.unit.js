'use strict';

const assert = require('assert').strict;
const {
  ALLOWED_METRIC_NAMES,
  configureApplicationInsights,
  createApplicationInsightsPrivacyProcessor
} = require('../../api/helpers/applicationInsightsPrivacy');

describe('Application Insights privacy processor', function() {
  it('accepts only fixed SDK performance metrics and strips context', function() {
    const processor = createApplicationInsightsPrivacyProcessor();
    const name = Array.from(ALLOWED_METRIC_NAMES)[0];
    const envelope = {
      ver: 1,
      time: '2026-09-17T09:00:00.000Z',
      sampleRate: 100,
      iKey: '00000000-0000-0000-0000-000000000000',
      seq: 'secret-sequence',
      secret: 'top-level-secret',
      tags: { userId: 'user-data', cloudRole: 'CBoard API' },
      data: {
        baseType: 'MetricData',
        baseData: {
          metrics: [{ name, value: 3, count: 1 }],
          properties: { email: 'user@example.test' },
          userField: 'unexpected'
        },
        secret: 'data-secret'
      }
    };

    assert.equal(processor(envelope), true);
    assert.deepEqual(envelope.tags, {});
    assert.deepEqual(envelope.data.baseData, {
      ver: 2,
      metrics: [{ name, value: 3, count: 1 }]
    });
    assert.equal(Object.prototype.hasOwnProperty.call(envelope, 'secret'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(envelope.data, 'secret'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(envelope, 'seq'), false);
    assert.equal(JSON.stringify(envelope).includes('user@example.test'), false);
  });

  it('drops non-metric and user-named metrics', function() {
    const processor = createApplicationInsightsPrivacyProcessor();
    const name = Array.from(ALLOWED_METRIC_NAMES)[0];
    assert.equal(processor({ data: { baseType: 'RequestData' } }), false);
    assert.equal(
      processor({
        data: {
          baseType: 'MetricData',
          baseData: { metrics: [{ name: 'user supplied', value: 1 }] }
        }
      }),
      false
    );
    assert.equal(
      processor({
        data: {
          baseType: 'MetricData',
          baseData: { metrics: [{ name, value: Infinity }] }
        }
      }),
      false
    );
    const validEnvelope = () => ({
      ver: 1,
      time: '2026-09-17T09:00:00.000Z',
      sampleRate: 100,
      iKey: '00000000-0000-0000-0000-000000000000',
      data: { baseType: 'MetricData', baseData: { metrics: [{ name, value: 1 }] } }
    });
    const invalidKey = validEnvelope();
    invalidKey.iKey = 'custom-secret';
    assert.equal(processor(invalidKey), false);
    const invalidTime = validEnvelope();
    invalidTime.time = 'not-a-date';
    assert.equal(processor(invalidTime), false);
    const invalidSampleRate = validEnvelope();
    invalidSampleRate.sampleRate = 101;
    assert.equal(processor(invalidSampleRate), false);
    const frozen = Object.freeze({
      ver: 1,
      time: '2026-09-17T09:00:00.000Z',
      sampleRate: 100,
      iKey: '00000000-0000-0000-0000-000000000000',
      data: Object.freeze({
        baseType: 'MetricData',
        baseData: Object.freeze({ metrics: [{ name, value: 1 }] })
      })
    });
    assert.equal(processor(frozen), false);
  });

  it('drops request, dependency, and trace details', function() {
    const processor = createApplicationInsightsPrivacyProcessor();
    for (const baseType of ['RequestData', 'RemoteDependencyData', 'MessageData']) {
      assert.equal(
        processor({ data: { baseType, baseData: { secret: 'token' } } }),
        false
      );
    }
  });

  it('returns false instead of throwing for hostile getters', function() {
    const processor = createApplicationInsightsPrivacyProcessor();
    const envelope = {};
    Object.defineProperty(envelope, 'data', {
      get() {
        throw new Error('synthetic getter failure');
      }
    });
    assert.doesNotThrow(() => assert.equal(processor(envelope), false));
  });

  it('configures the SDK with detail collection disabled and live metrics off', function() {
    const calls = [];
    const configuration = {};
    for (const method of [
      'setAutoDependencyCorrelation',
      'setAutoCollectRequests',
      'setAutoCollectPerformance',
      'setAutoCollectExceptions',
      'setAutoCollectDependencies',
      'setAutoCollectConsole',
      'setUseDiskRetryCaching',
      'setDistributedTracingMode',
      'setSendLiveMetrics'
    ]) {
      configuration[method] = (...args) => {
        calls.push([method, ...args]);
        return configuration;
      };
    }
    const fake = {
      DistributedTracingModes: { AI_AND_W3C: 'w3c' },
      defaultClient: { addTelemetryProcessor() { calls.push(['processor']); } },
      setup() { calls.push(['setup']); return configuration; }
    };
    configureApplicationInsights(fake);
    assert.deepEqual(calls, [
      ['setup'],
      ['setAutoDependencyCorrelation', true],
      ['setAutoCollectRequests', false],
      ['setAutoCollectPerformance', true, true],
      ['setAutoCollectExceptions', false],
      ['setAutoCollectDependencies', false],
      ['setAutoCollectConsole', false, false],
      ['setUseDiskRetryCaching', true],
      ['setDistributedTracingMode', 'w3c'],
      ['setSendLiveMetrics', false],
      ['processor']
    ]);
  });
});

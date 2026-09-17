'use strict';

const METRIC_DATA_TYPE = 'MetricData';
const IKEY_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// These are the fixed names emitted by applicationinsights' performance collector.
// User supplied metric names are intentionally rejected.
const ALLOWED_METRIC_NAMES = new Set([
  '\\Process(??APP_WIN32_PROC??)\\Private Bytes',
  '\\Memory\\Available Bytes',
  '\\Processor(_Total)\\% Processor Time',
  '\\Process(??APP_WIN32_PROC??)\\% Processor Time',
  '\\ASP.NET Applications(??APP_W3SVC_PROC??)\\Requests/Sec',
  '\\ASP.NET Applications(??APP_W3SVC_PROC??)\\Request Execution Time'
]);

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeMetric(metric) {
  if (!metric || typeof metric !== 'object') return null;
  if (!ALLOWED_METRIC_NAMES.has(metric.name) || !finiteNumber(metric.value)) {
    return null;
  }

  const result = { name: metric.name, value: metric.value };
  for (const field of ['count', 'min', 'max', 'stdDev']) {
    if (metric[field] !== undefined) {
      if (!finiteNumber(metric[field])) return null;
      result[field] = metric[field];
    }
  }
  return result;
}

function createApplicationInsightsPrivacyProcessor() {
  return function applicationInsightsPrivacyProcessor(envelope) {
    try {
      const data = envelope && envelope.data;
      if (!data || data.baseType !== METRIC_DATA_TYPE) return false;
      if (!envelope || envelope.ver !== 1) return false;
      if (
        typeof envelope.time !== 'string' ||
        !ISO_TIME_PATTERN.test(envelope.time) ||
        new Date(envelope.time).toISOString() !== envelope.time
      ) return false;
      if (
        typeof envelope.sampleRate !== 'number' ||
        !Number.isFinite(envelope.sampleRate) ||
        envelope.sampleRate < 0 ||
        envelope.sampleRate > 100
      ) return false;
      if (typeof envelope.iKey !== 'string' || !IKEY_PATTERN.test(envelope.iKey)) {
        return false;
      }
      const baseData = data.baseData;
      if (!baseData || !Array.isArray(baseData.metrics)) return false;

      const metrics = baseData.metrics.map(sanitizeMetric);
      if (!metrics.length || metrics.some(metric => !metric)) return false;

      // Keep only the numeric SDK metric payload. This also removes arbitrary
      // custom fields, user properties, and any context tags.
      envelope.data = {
        baseType: METRIC_DATA_TYPE,
        baseData: { ver: 2, metrics }
      };
      envelope.tags = {};
      const iKey = envelope.iKey.replace(/-/g, '');
      envelope.name = `Microsoft.ApplicationInsights.${iKey}.Metric`;
      for (const key of Object.keys(envelope)) {
        if (!['ver', 'name', 'time', 'sampleRate', 'iKey', 'tags', 'data'].includes(key)) {
          delete envelope[key];
        }
      }
      return true;
    } catch (_) {
      // TelemetryClient treats processor exceptions as fail-open. Never throw:
      // an unexpected/malicious getter must result in dropping this item.
      return false;
    }
  };
}

function configureApplicationInsights(appInsights, processor) {
  if (!appInsights || typeof appInsights.setup !== 'function') {
    throw new TypeError('Application Insights SDK is required');
  }
  appInsights
    .setup()
    .setAutoDependencyCorrelation(true)
    .setAutoCollectRequests(false)
    .setAutoCollectPerformance(true, true)
    .setAutoCollectExceptions(false)
    .setAutoCollectDependencies(false)
    .setAutoCollectConsole(false, false)
    .setUseDiskRetryCaching(true)
    .setDistributedTracingMode(appInsights.DistributedTracingModes.AI_AND_W3C)
    .setSendLiveMetrics(false);
  appInsights.defaultClient.addTelemetryProcessor(
    processor || createApplicationInsightsPrivacyProcessor()
  );
  return appInsights;
}

module.exports = {
  ALLOWED_METRIC_NAMES,
  configureApplicationInsights,
  createApplicationInsightsPrivacyProcessor,
  sanitizeMetric
};

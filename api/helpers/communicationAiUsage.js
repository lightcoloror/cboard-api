'use strict';

const CommunicationAiUsage = require('../models/CommunicationAiUsage');

const MAX_TOKENS_PER_RESPONSE = 1000000000;
const COMMUNICATION_AI_OPERATIONS = Object.freeze([
  'dialect-normalization',
  'edit-phrase',
  'ocr',
  'pictogram-generation',
  'pictogram-metadata',
  'resegment',
  'sentence-candidates'
]);
const OPERATION_SET = new Set(COMMUNICATION_AI_OPERATIONS);

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function normalizeTokenCount(value) {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number < 0 ||
    number > MAX_TOKENS_PER_RESPONSE
  ) {
    return null;
  }
  return number;
}

function pickTokenCount(source, primaryKey, compatibilityKey) {
  if (hasOwn(source, primaryKey)) {
    const primary = normalizeTokenCount(source[primaryKey]);
    if (primary !== null) return primary;
  }
  if (hasOwn(source, compatibilityKey)) {
    const compatibility = normalizeTokenCount(source[compatibilityKey]);
    if (compatibility !== null) return compatibility;
  }
  return null;
}

function normalizeCommunicationAiUsage(usage) {
  const source =
    usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : {};
  const promptTokenValue = pickTokenCount(
    source,
    'prompt_tokens',
    'input_tokens'
  );
  const completionTokenValue = pickTokenCount(
    source,
    'completion_tokens',
    'output_tokens'
  );
  const reportedTotal = hasOwn(source, 'total_tokens')
    ? normalizeTokenCount(source.total_tokens)
    : null;
  const reported =
    promptTokenValue !== null ||
    completionTokenValue !== null ||
    reportedTotal !== null;
  const promptTokens = promptTokenValue || 0;
  const completionTokens = completionTokenValue || 0;

  return {
    reported,
    promptTokens,
    completionTokens,
    totalTokens:
      reportedTotal === null
        ? Math.min(MAX_TOKENS_PER_RESPONSE, promptTokens + completionTokens)
        : reportedTotal
  };
}

function normalizeDimension(value, fallback, maxLength) {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
  return normalized || fallback;
}

function normalizeOperation(value) {
  const operation = String(value || '').trim();
  if (!OPERATION_SET.has(operation)) {
    throw new TypeError('Unsupported communication AI usage operation');
  }
  return operation;
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('Communication AI usage requires a valid date');
  }
  return date;
}

function getUtcMonth(value = new Date()) {
  return normalizeDate(value)
    .toISOString()
    .slice(0, 7);
}

function executeQuery(query) {
  return query && typeof query.exec === 'function' ? query.exec() : query;
}

function summarizeCommunicationAiUsage(rows, month) {
  const normalizeAggregateCount = value => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  };
  const addAggregateCount = (left, right) =>
    Math.min(Number.MAX_SAFE_INTEGER, left + right);
  const breakdown = (Array.isArray(rows) ? rows : [])
    .map(row => ({
      provider: normalizeDimension(row && row.provider, 'unknown', 64),
      model: normalizeDimension(row && row.model, 'unknown', 128),
      operation: normalizeDimension(row && row.operation, 'unknown', 64),
      requestCount: normalizeAggregateCount(row && row.requestCount),
      reportedRequestCount: normalizeAggregateCount(
        row && row.reportedRequestCount
      ),
      unreportedRequestCount: normalizeAggregateCount(
        row && row.unreportedRequestCount
      ),
      promptTokens: normalizeAggregateCount(row && row.promptTokens),
      completionTokens: normalizeAggregateCount(row && row.completionTokens),
      totalTokens: normalizeAggregateCount(row && row.totalTokens)
    }))
    .sort((left, right) =>
      `${left.operation}:${left.provider}:${left.model}`.localeCompare(
        `${right.operation}:${right.provider}:${right.model}`
      )
    );

  const totals = breakdown.reduce(
    (result, item) => {
      result.requestCount = addAggregateCount(
        result.requestCount,
        item.requestCount
      );
      result.reportedRequestCount = addAggregateCount(
        result.reportedRequestCount,
        item.reportedRequestCount
      );
      result.unreportedRequestCount = addAggregateCount(
        result.unreportedRequestCount,
        item.unreportedRequestCount
      );
      result.promptTokens = addAggregateCount(
        result.promptTokens,
        item.promptTokens
      );
      result.completionTokens = addAggregateCount(
        result.completionTokens,
        item.completionTokens
      );
      result.totalTokens = addAggregateCount(
        result.totalTokens,
        item.totalTokens
      );
      return result;
    },
    {
      requestCount: 0,
      reportedRequestCount: 0,
      unreportedRequestCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    }
  );

  return {
    month,
    ...totals,
    providerReported:
      totals.requestCount > 0 && totals.unreportedRequestCount === 0,
    breakdown
  };
}

function createCommunicationAiUsageService({
  model = CommunicationAiUsage,
  now = () => new Date()
} = {}) {
  async function recordUsage({
    userId,
    provider,
    model: providerModel,
    operation,
    usage
  }) {
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedUserId) {
      throw new TypeError('Communication AI usage requires a user');
    }

    const recordedAt = normalizeDate(now());
    const timestamp = recordedAt.getTime();
    const month = getUtcMonth(recordedAt);
    const normalizedUsage = normalizeCommunicationAiUsage(usage);
    const filter = {
      user: normalizedUserId,
      month,
      provider: normalizeDimension(provider, 'unknown', 64),
      model: normalizeDimension(providerModel, 'unknown', 128),
      operation: normalizeOperation(operation)
    };
    const update = {
      $inc: {
        requestCount: 1,
        reportedRequestCount: normalizedUsage.reported ? 1 : 0,
        unreportedRequestCount: normalizedUsage.reported ? 0 : 1,
        promptTokens: normalizedUsage.promptTokens,
        completionTokens: normalizedUsage.completionTokens,
        totalTokens: normalizedUsage.totalTokens
      },
      $set: { updatedAt: timestamp },
      $setOnInsert: {
        ...filter,
        createdAt: timestamp
      }
    };
    const options = {
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
      upsert: true
    };

    try {
      await executeQuery(model.findOneAndUpdate(filter, update, options));
    } catch (error) {
      if (!error || error.code !== 11000) throw error;
      await executeQuery(
        model.findOneAndUpdate(filter, update, {
          ...options,
          upsert: false
        })
      );
    }

    return {
      month,
      reported: normalizedUsage.reported,
      promptTokens: normalizedUsage.promptTokens,
      completionTokens: normalizedUsage.completionTokens,
      totalTokens: normalizedUsage.totalTokens
    };
  }

  async function getMonthlyUsage({ userId, month = getUtcMonth(now()) }) {
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedUserId) {
      throw new TypeError('Communication AI usage requires a user');
    }
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new TypeError('Communication AI usage requires a valid month');
    }

    const query = model.find({ user: normalizedUserId, month });
    const rows = await executeQuery(
      query && typeof query.lean === 'function' ? query.lean() : query
    );
    return summarizeCommunicationAiUsage(rows, month);
  }

  return { getMonthlyUsage, recordUsage };
}

const defaultService = createCommunicationAiUsageService();

async function settleAndRecordCommunicationAiUsage({
  req,
  provider,
  event,
  recordUsageImpl = input => defaultService.recordUsage(input)
}) {
  const quotaService =
    req && req.communicationAiTokenQuotaService;
  const reservation =
    req && req.communicationAiTokenQuotaReservation;
  if (quotaService && reservation) {
    await quotaService.settleReservation(reservation, event.usage);
  }
  return recordUsageImpl({
    userId: req && req.user && req.user.id,
    provider: provider.provider,
    model: event.model || provider.model,
    operation: event.operation,
    usage: event.usage
  });
}

module.exports = {
  COMMUNICATION_AI_OPERATIONS,
  MAX_TOKENS_PER_RESPONSE,
  createCommunicationAiUsageService,
  getMonthlyUsage: (...args) => defaultService.getMonthlyUsage(...args),
  getUtcMonth,
  normalizeCommunicationAiUsage,
  recordUsage: (...args) => defaultService.recordUsage(...args),
  settleAndRecordCommunicationAiUsage,
  summarizeCommunicationAiUsage
};

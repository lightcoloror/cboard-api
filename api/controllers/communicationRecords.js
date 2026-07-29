'use strict';

const CommunicationReceiverRecord = require('../models/CommunicationReceiverRecord');
const {
  normalizePublicPictogramAttribution
} = require('../helpers/pictogramAttribution');

const MAX_SYNC_RECORDS = 100;
const MAX_SEQUENCE_ITEMS = 50;
const MAX_PATIENT_FEEDBACK_EVENTS = 20;
const PATIENT_FEEDBACK_TYPES = new Set([
  'understood',
  'not_understood',
  'repeat_requested'
]);
const MATCH_TYPES = new Set([
  'exact',
  'synonym',
  'lexicon',
  'partial',
  'online',
  'ai',
  'manual',
  'missing'
]);
const SOURCES = new Set(['local_dict', 'arasaac', 'opensymbols', 'ai', 'user']);
module.exports = {
  deleteConfirmedReceiverRecords,
  syncConfirmedReceiverRecords
};

function normalizeString(value, maxLength) {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? Math.floor(timestamp)
    : null;
}

function normalizeVersion(value, allowZero = false) {
  const version = Number(value);
  return Number.isInteger(version) && (allowZero ? version >= 0 : version > 0)
    ? version
    : null;
}

function normalizeSequenceItem(value) {
  if (!value || typeof value !== 'object') return null;
  const originalToken = normalizeString(value.originalToken, 120);
  const label = normalizeString(value.label, 120);
  if (!originalToken && !label) return null;

  const matchType = MATCH_TYPES.has(value.matchType)
    ? value.matchType
    : 'missing';
  const source = SOURCES.has(value.source) ? value.source : 'local_dict';
  const confidence = Number(value.confidence);
  const attribution = normalizePublicPictogramAttribution(value.attribution);

  return {
    pictogramId:
      source === 'user'
        ? null
        : normalizeString(value.pictogramId, 200) || null,
    label,
    source,
    matchType,
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0,
    originalToken,
    ...(attribution ? { attribution } : {})
  };
}

function normalizePatientFeedbackFields(record, confirmedAt, updatedAt) {
  const hasOwn = field => Object.prototype.hasOwnProperty.call(record, field);
  const hasEvents = hasOwn('patientFeedbackEvents');
  const hasFeedback = hasOwn('patientFeedback');
  const hasFeedbackAt = hasOwn('patientFeedbackAt');

  if (!hasEvents && !hasFeedback && !hasFeedbackAt) {
    return {};
  }
  if (
    hasEvents &&
    (!Array.isArray(record.patientFeedbackEvents) ||
      record.patientFeedbackEvents.length > MAX_PATIENT_FEEDBACK_EVENTS)
  ) {
    return null;
  }

  const patientFeedback = hasFeedback
    ? normalizeString(record.patientFeedback, 40)
    : null;
  const patientFeedbackAt = hasFeedbackAt
    ? normalizeTimestamp(record.patientFeedbackAt)
    : null;
  if (
    (hasFeedback && !PATIENT_FEEDBACK_TYPES.has(patientFeedback)) ||
    (hasFeedbackAt && !patientFeedbackAt)
  ) {
    return null;
  }

  const patientFeedbackEvents = (hasEvents
    ? record.patientFeedbackEvents
    : []
  ).map(event => {
    if (!event || typeof event !== 'object') return null;
    const type = normalizeString(event.type, 40);
    const createdAt = normalizeTimestamp(event.createdAt);
    return PATIENT_FEEDBACK_TYPES.has(type) && createdAt
      ? { type, createdAt }
      : null;
  });
  if (patientFeedbackEvents.some(event => !event)) {
    return null;
  }
  patientFeedbackEvents.sort((left, right) => left.createdAt - right.createdAt);

  if (!patientFeedbackEvents.length) {
    if (hasFeedback !== hasFeedbackAt) return null;
    if (hasFeedback && hasFeedbackAt) {
      patientFeedbackEvents.push({
        type: patientFeedback,
        createdAt: patientFeedbackAt
      });
    }
  }
  if (!patientFeedbackEvents.length) {
    return {};
  }

  const latest = patientFeedbackEvents[patientFeedbackEvents.length - 1];
  if (
    (hasFeedback && patientFeedback !== latest.type) ||
    (hasFeedbackAt && patientFeedbackAt !== latest.createdAt) ||
    latest.createdAt < confirmedAt ||
    latest.createdAt > updatedAt
  ) {
    return null;
  }

  return {
    patientFeedback: latest.type,
    patientFeedbackAt: latest.createdAt,
    patientFeedbackEvents
  };
}

function mergePatientFeedbackFields(existing, incoming) {
  const existingFields =
    normalizePatientFeedbackFields(
      existing,
      normalizeTimestamp(existing.confirmedAt),
      normalizeTimestamp(existing.updatedAt)
    ) || {};
  const incomingFields =
    normalizePatientFeedbackFields(
      incoming,
      normalizeTimestamp(incoming.confirmedAt),
      normalizeTimestamp(incoming.updatedAt)
    ) || {};
  const events = [
    ...(existingFields.patientFeedbackEvents || []),
    ...(incomingFields.patientFeedbackEvents || [])
  ]
    .sort((left, right) => left.createdAt - right.createdAt)
    .filter(
      (event, index, list) =>
        index ===
        list.findIndex(
          candidate =>
            candidate.type === event.type &&
            candidate.createdAt === event.createdAt
        )
    )
    .slice(-MAX_PATIENT_FEEDBACK_EVENTS);

  if (!events.length) return {};
  const latest = events[events.length - 1];
  return {
    patientFeedback: latest.type,
    patientFeedbackAt: latest.createdAt,
    patientFeedbackEvents: events
  };
}

function containsAllPatientFeedbackEvents(stored, incoming) {
  const incomingFields =
    normalizePatientFeedbackFields(
      incoming,
      normalizeTimestamp(incoming.confirmedAt),
      normalizeTimestamp(incoming.updatedAt)
    ) || {};
  const incomingEvents = incomingFields.patientFeedbackEvents || [];
  if (!incomingEvents.length) return true;

  const storedFields =
    normalizePatientFeedbackFields(
      stored,
      normalizeTimestamp(stored.confirmedAt),
      normalizeTimestamp(stored.updatedAt)
    ) || {};
  const storedKeys = new Set(
    (storedFields.patientFeedbackEvents || []).map(
      event => `${event.type}:${event.createdAt}`
    )
  );
  return incomingEvents.every(event =>
    storedKeys.has(`${event.type}:${event.createdAt}`)
  );
}

function buildImmutableRecordSignature(record) {
  return JSON.stringify({
    sessionId: normalizeString(record.sessionId, 200),
    patientId: normalizeString(record.patientId, 200),
    workspaceId: normalizeString(record.workspaceId, 200),
    inputText: normalizeString(record.inputText, 2000),
    labels: (Array.isArray(record.labels) ? record.labels : [])
      .map(label => normalizeString(label, 120))
      .filter(Boolean)
      .slice(0, MAX_SEQUENCE_ITEMS),
    pictogramSequence: (Array.isArray(record.pictogramSequence)
      ? record.pictogramSequence
      : []
    )
      .map(normalizeSequenceItem)
      .filter(Boolean)
      .slice(0, MAX_SEQUENCE_ITEMS),
    contractVersion:
      Number.isInteger(record.contractVersion) && record.contractVersion > 0
        ? record.contractVersion
        : 1,
    createdAt: normalizeTimestamp(record.createdAt),
    confirmedAt: normalizeTimestamp(record.confirmedAt)
  });
}

function getServerVersion(record) {
  return normalizeVersion(record && record.serverVersion) || 1;
}

function buildDeletedRecordTombstone(record, fallback = {}) {
  const id = normalizeString(
    (record && (record.clientRecordId || record.id)) || fallback.id,
    200
  );
  const deletedAt =
    normalizeTimestamp(record && record.deletedAt) ||
    normalizeTimestamp(fallback.deletedAt);
  const deletedBy = normalizeString(
    (record && record.deletedBy) || fallback.deletedBy,
    200
  );
  if (!id || !deletedAt || !deletedBy) return null;

  return {
    id,
    deletedAt,
    deletedBy,
    serverVersion:
      normalizeVersion(record && record.serverVersion) ||
      normalizeVersion(fallback.serverVersion) ||
      1
  };
}

function normalizeConfirmedRecord(record, userId) {
  if (
    !record ||
    typeof record !== 'object' ||
    record.recordStatus !== 'confirmed' ||
    (record.direction && record.direction !== 'receive')
  ) {
    return null;
  }

  const clientRecordId = normalizeString(record.id, 200);
  const sessionId = normalizeString(record.sessionId, 200);
  const patientId = normalizeString(record.patientId, 200);
  const workspaceId = normalizeString(record.workspaceId, 200);
  const inputText = normalizeString(record.inputText, 2000);
  const createdAt = normalizeTimestamp(record.createdAt);
  const updatedAt = normalizeTimestamp(record.updatedAt);
  const confirmedAt =
    normalizeTimestamp(record.confirmedAt) || updatedAt || createdAt;
  const hasBaseVersion = Object.prototype.hasOwnProperty.call(
    record,
    'baseVersion'
  );
  const baseVersion = hasBaseVersion
    ? normalizeVersion(record.baseVersion, true)
    : 0;

  if (
    !clientRecordId ||
    !sessionId ||
    !patientId ||
    !workspaceId ||
    !inputText ||
    !createdAt ||
    !updatedAt ||
    !confirmedAt ||
    baseVersion === null
  ) {
    return null;
  }

  const patientFeedbackFields = normalizePatientFeedbackFields(
    record,
    confirmedAt,
    updatedAt
  );
  if (!patientFeedbackFields) {
    return null;
  }

  return {
    user: userId,
    clientRecordId,
    sessionId,
    patientId,
    workspaceId,
    direction: 'receive',
    recordStatus: 'confirmed',
    inputText,
    labels: (Array.isArray(record.labels) ? record.labels : [])
      .map(label => normalizeString(label, 120))
      .filter(Boolean)
      .slice(0, MAX_SEQUENCE_ITEMS),
    pictogramSequence: (Array.isArray(record.pictogramSequence)
      ? record.pictogramSequence
      : []
    )
      .map(normalizeSequenceItem)
      .filter(Boolean)
      .slice(0, MAX_SEQUENCE_ITEMS),
    contractVersion:
      Number.isInteger(record.contractVersion) && record.contractVersion > 0
        ? record.contractVersion
        : 1,
    ...patientFeedbackFields,
    createdAt,
    updatedAt,
    confirmedAt,
    baseVersion
  };
}

function serializeRecord(record, conflicted = false) {
  const patientFeedbackFields =
    normalizePatientFeedbackFields(
      record,
      normalizeTimestamp(record.confirmedAt),
      normalizeTimestamp(record.updatedAt)
    ) || {};

  return {
    id: record.clientRecordId,
    sessionId: record.sessionId,
    patientId: record.patientId,
    workspaceId: record.workspaceId,
    direction: 'receive',
    recordStatus: 'confirmed',
    inputText: record.inputText,
    labels: record.labels || [],
    pictogramSequence: record.pictogramSequence || [],
    contractVersion: record.contractVersion || 1,
    ...patientFeedbackFields,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    confirmedAt: record.confirmedAt,
    serverVersion: getServerVersion(record),
    conflicted: Boolean(conflicted)
  };
}

function buildPersistentRecord(record) {
  const persistent = { ...record };
  delete persistent.baseVersion;
  persistent.serverVersion = 1;
  persistent.deletedAt = null;
  persistent.deletedBy = null;
  return persistent;
}

async function syncConfirmedReceiverRecords(req, res) {
  if (!req.user) {
    return res.status(400).json({
      message: 'Are you logged in? Is bearer token present?'
    });
  }

  const records = req.body && req.body.records;
  if (!Array.isArray(records) || records.length > MAX_SYNC_RECORDS) {
    return res.status(400).json({
      message: `records must be an array with at most ${MAX_SYNC_RECORDS} items`
    });
  }

  const normalized = records.map(record =>
    normalizeConfirmedRecord(record, req.user.id)
  );
  if (normalized.some(record => !record)) {
    return res.status(400).json({
      message: 'Only complete confirmed receiver records can be synced'
    });
  }

  try {
    const requestedIds = normalized.map(record => record.clientRecordId);
    const existing = requestedIds.length
      ? await CommunicationReceiverRecord.find({
          user: req.user.id,
          clientRecordId: { $in: requestedIds }
        })
          .lean()
          .exec()
      : [];
    const existingById = new Map(
      existing.map(record => [record.clientRecordId, record])
    );
    const conflictedRecordIds = new Set();
    const operations = [];

    normalized.forEach(record => {
      const existingRecord = existingById.get(record.clientRecordId);
      if (!existingRecord) {
        operations.push({
          updateOne: {
            filter: {
              user: req.user.id,
              clientRecordId: record.clientRecordId
            },
            update: {
              $setOnInsert: buildPersistentRecord(record)
            },
            upsert: true
          }
        });
        return;
      }

      const serverVersion = getServerVersion(existingRecord);
      const versionConflict = record.baseVersion !== serverVersion;
      const immutableConflict =
        buildImmutableRecordSignature(record) !==
        buildImmutableRecordSignature(existingRecord);
      if (existingRecord.deletedAt || versionConflict || immutableConflict) {
        conflictedRecordIds.add(record.clientRecordId);
      }
      if (existingRecord.deletedAt) return;

      const existingFeedback =
        normalizePatientFeedbackFields(
          existingRecord,
          normalizeTimestamp(existingRecord.confirmedAt),
          normalizeTimestamp(existingRecord.updatedAt)
        ) || {};
      const mergedFeedback = mergePatientFeedbackFields(existingRecord, record);
      const feedbackChanged =
        JSON.stringify(existingFeedback) !== JSON.stringify(mergedFeedback);
      const needsVersionMigration =
        normalizeVersion(existingRecord.serverVersion) === null;
      if (!feedbackChanged && !needsVersionMigration) return;

      const nextVersion = feedbackChanged ? serverVersion + 1 : serverVersion;
      const update = {
        serverVersion: nextVersion,
        updatedAt: Math.max(
          normalizeTimestamp(existingRecord.updatedAt) || 0,
          normalizeTimestamp(record.updatedAt) || 0,
          normalizeTimestamp(mergedFeedback.patientFeedbackAt) || 0
        )
      };
      if (mergedFeedback.patientFeedbackEvents) {
        Object.assign(update, mergedFeedback);
      }
      operations.push({
        updateOne: {
          filter: {
            user: req.user.id,
            clientRecordId: record.clientRecordId,
            deletedAt: null,
            $or: [{ serverVersion }, { serverVersion: { $exists: false } }]
          },
          update: { $set: update }
        }
      });
    });

    if (operations.length) {
      await CommunicationReceiverRecord.bulkWrite(operations);
    }

    const stored = await CommunicationReceiverRecord.find({
      user: req.user.id
    })
      .sort({ updatedAt: -1 })
      .limit(MAX_SYNC_RECORDS * 2)
      .lean()
      .exec();
    const activeRecords = stored
      .filter(record => !record.deletedAt)
      .slice(0, MAX_SYNC_RECORDS);
    const activeById = new Map(
      activeRecords.map(record => [record.clientRecordId, record])
    );
    const deletedRecordIds = stored
      .filter(record => record.deletedAt)
      .map(record => record.clientRecordId)
      .filter(Boolean)
      .slice(0, MAX_SYNC_RECORDS);
    const deletedRecords = stored
      .filter(record => record.deletedAt)
      .map(record => buildDeletedRecordTombstone(record))
      .filter(Boolean)
      .slice(0, MAX_SYNC_RECORDS);
    normalized.forEach(record => {
      const storedRecord = activeById.get(record.clientRecordId);
      if (
        !storedRecord ||
        !containsAllPatientFeedbackEvents(storedRecord, record)
      ) {
        conflictedRecordIds.add(record.clientRecordId);
      }
    });

    return res.status(200).json({
      acceptedCount: normalized.length - conflictedRecordIds.size,
      conflictCount: conflictedRecordIds.size,
      conflictedRecordIds: [...conflictedRecordIds],
      records: activeRecords.map(record =>
        serializeRecord(record, conflictedRecordIds.has(record.clientRecordId))
      ),
      deletedRecordIds,
      deletedRecords
    });
  } catch (error) {
    return res.status(409).json({
      message: 'Error syncing confirmed receiver records',
      error: error.message
    });
  }
}

async function deleteConfirmedReceiverRecords(req, res) {
  if (!req.user) {
    return res.status(400).json({
      message: 'Are you logged in? Is bearer token present?'
    });
  }

  const deleteAll = Boolean(req.body && req.body.deleteAll);
  const recordIds = Array.from(
    new Set(
      (Array.isArray(req.body && req.body.recordIds) ? req.body.recordIds : [])
        .map(value => normalizeString(value, 200))
        .filter(Boolean)
    )
  ).slice(0, MAX_SYNC_RECORDS);

  if (!deleteAll && !recordIds.length) {
    return res.status(400).json({
      message: 'recordIds must contain at least one record id'
    });
  }

  const filter = { user: req.user.id, deletedAt: null };
  if (!deleteAll) {
    filter.clientRecordId = { $in: recordIds };
  }
  const deletedAt = Date.now();

  try {
    const activeRecords = await CommunicationReceiverRecord.find(filter)
      .sort({ updatedAt: -1 })
      .limit(MAX_SYNC_RECORDS)
      .lean()
      .exec();
    const activeById = new Map(
      activeRecords.map(record => [record.clientRecordId, record])
    );
    const targetIds = deleteAll
      ? activeRecords.map(record => record.clientRecordId).filter(Boolean)
      : recordIds;
    await CommunicationReceiverRecord.updateMany(
      {
        ...filter,
        serverVersion: { $exists: false }
      },
      { $set: { serverVersion: 1 } }
    );
    const result = await CommunicationReceiverRecord.updateMany(filter, {
      $set: {
        deletedAt,
        deletedBy: req.user.id,
        updatedAt: deletedAt
      },
      $inc: { serverVersion: 1 }
    });
    const deletedRecords = targetIds
      .map(id =>
        buildDeletedRecordTombstone(null, {
          id,
          deletedAt,
          deletedBy: req.user.id,
          serverVersion: getServerVersion(activeById.get(id)) + 1
        })
      )
      .filter(Boolean);
    return res.status(200).json({
      deletedCount: Number(result.modifiedCount || result.nModified) || 0,
      deletedRecordIds: targetIds,
      deletedRecords
    });
  } catch (error) {
    return res.status(409).json({
      message: 'Error deleting confirmed receiver records',
      error: error.message
    });
  }
}

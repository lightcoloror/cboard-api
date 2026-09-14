'use strict';

const CommunicationSavedPhrase = require('../models/CommunicationSavedPhrase');
const {
  normalizeHttpsUrl,
  normalizePublicPictogramAttribution
} = require('../helpers/pictogramAttribution');

const MAX_SYNC_PHRASES = 100;
const MAX_OUTPUT_ITEMS = 50;
module.exports = {
  deleteCommunicationSavedPhrases,
  syncCommunicationSavedPhrases
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

function normalizeUsageCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
}

function normalizeOutputItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const id = normalizeString(value.id, 200);
  const label = normalizeString(value.label, 160);
  if (!id && !label) return null;

  const source =
    typeof value.source === 'string' ? normalizeString(value.source, 80) : '';
  const hasAttribution =
    Object.prototype.hasOwnProperty.call(value, 'attribution') &&
    value.attribution != null;
  const attribution = normalizePublicPictogramAttribution(value.attribution);
  const image =
    hasAttribution && !attribution ? null : normalizeHttpsUrl(value.image);
  const isDevicePrivate = source === 'user' || /^device_private_/i.test(id);
  if (isDevicePrivate) {
    return label ? { label } : null;
  }

  return {
    ...(id ? { id } : {}),
    label,
    ...(image ? { image } : {}),
    ...(source ? { source } : {}),
    ...(attribution ? { attribution } : {})
  };
}

function normalizeSavedPhrase(value, userId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const clientPhraseId = normalizeString(value.id, 200);
  const sentence = normalizeString(value.sentence, 500);
  const createdAt = normalizeTimestamp(value.createdAt);
  const lastUsedAt = normalizeTimestamp(value.lastUsedAt) || createdAt;
  const updatedAt = normalizeTimestamp(value.updatedAt) || lastUsedAt;
  const usageCount = normalizeUsageCount(value.usageCount || 0);
  const baseVersion = Object.prototype.hasOwnProperty.call(value, 'baseVersion')
    ? normalizeVersion(value.baseVersion, true)
    : 0;
  const outputValues = value.output;
  if (
    !clientPhraseId ||
    !sentence ||
    !createdAt ||
    !lastUsedAt ||
    !updatedAt ||
    usageCount === null ||
    baseVersion === null ||
    !Array.isArray(outputValues) ||
    outputValues.length > MAX_OUTPUT_ITEMS
  ) {
    return null;
  }

  const output = outputValues.map(normalizeOutputItem);
  if (output.some(item => !item)) return null;

  return {
    user: userId,
    clientPhraseId,
    sentence,
    output,
    usageCount,
    contractVersion:
      Number.isInteger(value.contractVersion) && value.contractVersion > 0
        ? value.contractVersion
        : 1,
    createdAt,
    lastUsedAt,
    updatedAt,
    baseVersion
  };
}

function getServerVersion(value) {
  return normalizeVersion(value && value.serverVersion) || 1;
}

function buildSavedPhraseSignature(value) {
  return JSON.stringify({
    sentence: normalizeString(value.sentence, 500),
    output: (Array.isArray(value.output) ? value.output : [])
      .map(normalizeOutputItem)
      .filter(Boolean)
      .slice(0, MAX_OUTPUT_ITEMS),
    usageCount: normalizeUsageCount(value.usageCount || 0) || 0,
    contractVersion:
      Number.isInteger(value.contractVersion) && value.contractVersion > 0
        ? value.contractVersion
        : 1,
    createdAt: normalizeTimestamp(value.createdAt),
    lastUsedAt: normalizeTimestamp(value.lastUsedAt),
    updatedAt: normalizeTimestamp(value.updatedAt)
  });
}

function serializeSavedPhrase(value, conflicted = false) {
  return {
    id: value.clientPhraseId,
    sentence: value.sentence,
    output: value.output || [],
    usageCount: normalizeUsageCount(value.usageCount || 0) || 0,
    contractVersion: value.contractVersion || 1,
    createdAt: value.createdAt,
    lastUsedAt: value.lastUsedAt,
    updatedAt: value.updatedAt,
    serverVersion: getServerVersion(value),
    conflicted: Boolean(conflicted)
  };
}

function buildSavedPhraseTombstone(value) {
  const id = normalizeString(value && (value.clientPhraseId || value.id), 200);
  const deletedAt = normalizeTimestamp(value && value.deletedAt);
  const deletedBy = normalizeString(value && value.deletedBy, 200);
  if (!id || !deletedAt || !deletedBy) return null;

  return {
    id,
    deletedAt,
    deletedBy,
    serverVersion: getServerVersion(value)
  };
}

function buildPersistentSavedPhrase(value) {
  const persistent = { ...value };
  delete persistent.baseVersion;
  persistent.serverVersion = 1;
  persistent.deletedAt = null;
  persistent.deletedBy = null;
  return persistent;
}

function buildDeletedSavedPhrase(userId, id, deletedAt) {
  return {
    user: userId,
    clientPhraseId: id,
    sentence: '',
    output: [],
    usageCount: 0,
    contractVersion: 1,
    createdAt: deletedAt,
    lastUsedAt: deletedAt,
    updatedAt: deletedAt,
    serverVersion: 1,
    deletedAt,
    deletedBy: userId
  };
}

async function syncCommunicationSavedPhrases(req, res) {
  if (process.env.CARE_NEXT_ENABLED === 'true') {
    return res.status(409).json({ code: 'USE_PATIENT_SYNC', message: 'Use the scoped patient favorite endpoints.' });
  }
  if (!req.user) {
    return res.status(400).json({
      message: 'Are you logged in? Is bearer token present?'
    });
  }

  const phrases = req.body && req.body.phrases;
  if (!Array.isArray(phrases) || phrases.length > MAX_SYNC_PHRASES) {
    return res.status(400).json({
      message: `phrases must be an array with at most ${MAX_SYNC_PHRASES} items`
    });
  }

  const normalized = phrases.map(phrase =>
    normalizeSavedPhrase(phrase, req.user.id)
  );
  if (normalized.some(phrase => !phrase)) {
    return res.status(400).json({
      message: 'Only complete public saved phrases can be synced'
    });
  }

  try {
    const requestedIds = normalized.map(phrase => phrase.clientPhraseId);
    const existing = requestedIds.length
      ? await CommunicationSavedPhrase.find({
          user: req.user.id,
          clientPhraseId: { $in: requestedIds }
        })
          .lean()
          .exec()
      : [];
    const existingById = new Map(
      existing.map(phrase => [phrase.clientPhraseId, phrase])
    );
    const conflictedPhraseIds = new Set();
    const operations = [];

    normalized.forEach(phrase => {
      const existingPhrase = existingById.get(phrase.clientPhraseId);
      if (!existingPhrase) {
        operations.push({
          updateOne: {
            filter: {
              user: req.user.id,
              clientPhraseId: phrase.clientPhraseId
            },
            update: {
              $setOnInsert: buildPersistentSavedPhrase(phrase)
            },
            upsert: true
          }
        });
        return;
      }

      if (existingPhrase.deletedAt) {
        conflictedPhraseIds.add(phrase.clientPhraseId);
        return;
      }

      const incomingSignature = buildSavedPhraseSignature(phrase);
      const existingSignature = buildSavedPhraseSignature(existingPhrase);
      if (incomingSignature === existingSignature) return;

      const serverVersion = getServerVersion(existingPhrase);
      if (phrase.baseVersion !== serverVersion) {
        conflictedPhraseIds.add(phrase.clientPhraseId);
        return;
      }

      operations.push({
        updateOne: {
          filter: {
            user: req.user.id,
            clientPhraseId: phrase.clientPhraseId,
            deletedAt: null,
            $or: [{ serverVersion }, { serverVersion: { $exists: false } }]
          },
          update: {
            $set: {
              sentence: phrase.sentence,
              output: phrase.output,
              usageCount: phrase.usageCount,
              contractVersion: phrase.contractVersion,
              createdAt: phrase.createdAt,
              lastUsedAt: phrase.lastUsedAt,
              updatedAt: phrase.updatedAt,
              serverVersion: serverVersion + 1
            }
          }
        }
      });
    });

    if (operations.length) {
      await CommunicationSavedPhrase.bulkWrite(operations);
    }

    const stored = await CommunicationSavedPhrase.find({
      user: req.user.id
    })
      .sort({ updatedAt: -1 })
      .limit(MAX_SYNC_PHRASES * 2)
      .lean()
      .exec();
    const activePhrases = stored
      .filter(phrase => !phrase.deletedAt)
      .slice(0, MAX_SYNC_PHRASES);
    const activeById = new Map(
      activePhrases.map(phrase => [phrase.clientPhraseId, phrase])
    );
    const deletedPhrases = stored
      .filter(phrase => phrase.deletedAt)
      .map(buildSavedPhraseTombstone)
      .filter(Boolean)
      .slice(0, MAX_SYNC_PHRASES);

    normalized.forEach(phrase => {
      if (conflictedPhraseIds.has(phrase.clientPhraseId)) return;
      const storedPhrase = activeById.get(phrase.clientPhraseId);
      if (
        !storedPhrase ||
        buildSavedPhraseSignature(storedPhrase) !==
          buildSavedPhraseSignature(phrase)
      ) {
        conflictedPhraseIds.add(phrase.clientPhraseId);
      }
    });

    return res.status(200).json({
      acceptedCount: normalized.length - conflictedPhraseIds.size,
      conflictCount: conflictedPhraseIds.size,
      conflictedPhraseIds: [...conflictedPhraseIds],
      phrases: activePhrases.map(phrase =>
        serializeSavedPhrase(
          phrase,
          conflictedPhraseIds.has(phrase.clientPhraseId)
        )
      ),
      deletedPhraseIds: deletedPhrases.map(phrase => phrase.id),
      deletedPhrases
    });
  } catch (error) {
    return res.status(409).json({
      message: 'Error syncing communication saved phrases',
      error: error.message
    });
  }
}

async function deleteCommunicationSavedPhrases(req, res) {
  if (process.env.CARE_NEXT_ENABLED === 'true') {
    return res.status(409).json({ code: 'USE_PATIENT_SYNC', message: 'Use the scoped patient favorite endpoints.' });
  }
  if (!req.user) {
    return res.status(400).json({
      message: 'Are you logged in? Is bearer token present?'
    });
  }

  const deleteAll = Boolean(req.body && req.body.deleteAll);
  const requestedValues = Array.isArray(req.body && req.body.phraseIds)
    ? req.body.phraseIds
    : [];
  if (requestedValues.length > MAX_SYNC_PHRASES) {
    return res.status(400).json({
      message: `phraseIds must contain at most ${MAX_SYNC_PHRASES} items`
    });
  }
  const phraseIds = Array.from(
    new Set(
      requestedValues.map(value => normalizeString(value, 200)).filter(Boolean)
    )
  );

  if (!deleteAll && !phraseIds.length) {
    return res.status(400).json({
      message: 'phraseIds must contain at least one phrase id'
    });
  }

  try {
    const lookup = deleteAll
      ? { user: req.user.id, deletedAt: null }
      : {
          user: req.user.id,
          clientPhraseId: { $in: phraseIds }
        };
    const existing = await CommunicationSavedPhrase.find(lookup)
      .sort({ updatedAt: -1 })
      .limit(MAX_SYNC_PHRASES)
      .lean()
      .exec();
    const existingById = new Map(
      existing.map(phrase => [phrase.clientPhraseId, phrase])
    );
    const targetIds = deleteAll
      ? existing.map(phrase => phrase.clientPhraseId).filter(Boolean)
      : phraseIds;
    const deletedAt = Date.now();
    const changedIds = new Set();
    const operations = [];

    targetIds.forEach(id => {
      const phrase = existingById.get(id);
      if (phrase && phrase.deletedAt) return;
      changedIds.add(id);

      if (!phrase) {
        operations.push({
          updateOne: {
            filter: {
              user: req.user.id,
              clientPhraseId: id
            },
            update: {
              $setOnInsert: buildDeletedSavedPhrase(req.user.id, id, deletedAt)
            },
            upsert: true
          }
        });
        return;
      }

      const serverVersion = getServerVersion(phrase);
      operations.push({
        updateOne: {
          filter: {
            user: req.user.id,
            clientPhraseId: id,
            deletedAt: null,
            $or: [{ serverVersion }, { serverVersion: { $exists: false } }]
          },
          update: {
            $set: {
              deletedAt,
              deletedBy: req.user.id,
              updatedAt: deletedAt,
              serverVersion: serverVersion + 1
            }
          }
        }
      });
    });

    if (operations.length) {
      await CommunicationSavedPhrase.bulkWrite(operations);
    }

    const stored = targetIds.length
      ? await CommunicationSavedPhrase.find({
          user: req.user.id,
          clientPhraseId: { $in: targetIds }
        })
          .lean()
          .exec()
      : [];
    const deletedPhrases = stored
      .filter(phrase => phrase.deletedAt)
      .map(buildSavedPhraseTombstone)
      .filter(Boolean);
    const deletedIds = new Set(deletedPhrases.map(phrase => phrase.id));
    const conflictedPhraseIds = targetIds.filter(id => !deletedIds.has(id));
    if (conflictedPhraseIds.length) {
      return res.status(409).json({
        message: 'Saved phrase deletion lost a concurrent update',
        conflictedPhraseIds,
        deletedPhrases
      });
    }

    return res.status(200).json({
      deletedCount: changedIds.size,
      deletedPhraseIds: targetIds,
      deletedPhrases
    });
  } catch (error) {
    return res.status(409).json({
      message: 'Error deleting communication saved phrases',
      error: error.message
    });
  }
}

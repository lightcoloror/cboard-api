'use strict';

module.exports = {
  deleteCommunicationSavedPhrases,
  syncCommunicationSavedPhrases
};

function syncCommunicationSavedPhrases(req, res) {
  const phrases = req.body.phrases.map(value => {
    const phrase = { ...value };
    delete phrase.baseVersion;
    return {
      ...phrase,
      serverVersion: 1,
      conflicted: false
    };
  });

  return res.status(200).json({
    acceptedCount: phrases.length,
    conflictCount: 0,
    conflictedPhraseIds: [],
    phrases,
    deletedPhraseIds: [],
    deletedPhrases: []
  });
}

function deleteCommunicationSavedPhrases(req, res) {
  const phraseIds = req.body.phraseIds || [];
  const deletedPhrases = phraseIds.map(id => ({
    id,
    deletedAt: 1,
    deletedBy: 'user-1',
    serverVersion: 1
  }));

  return res.status(200).json({
    deletedCount: deletedPhrases.length,
    deletedPhraseIds: phraseIds,
    deletedPhrases
  });
}

'use strict';

module.exports = {
  deleteConfirmedReceiverRecords(req, res) {
    const recordIds = Array.isArray(req.body.recordIds)
      ? req.body.recordIds
      : [];
    return res.status(200).json({
      deletedCount: req.body.deleteAll ? 100 : recordIds.length,
      deletedRecordIds: req.body.deleteAll ? [] : recordIds,
      deletedRecords: (req.body.deleteAll ? [] : recordIds).map(id => ({
        id,
        deletedAt: 30,
        deletedBy: 'user-1',
        serverVersion: 2
      }))
    });
  },
  syncConfirmedReceiverRecords(req, res) {
    return res.status(200).json({
      acceptedCount: req.body.records.length,
      conflictCount: 0,
      conflictedRecordIds: [],
      records: req.body.records.map(record => ({
        ...record,
        serverVersion: 1,
        conflicted: false
      })),
      deletedRecordIds: [],
      deletedRecords: []
    });
  }
};

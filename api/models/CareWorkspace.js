'use strict';
const mongoose = require('mongoose');
function model(name, fields) {
  return mongoose.models[name] || mongoose.model(name, new mongoose.Schema(fields, { minimize: false }));
}
exports.Family = model('CareFamily', { _id: String, owner: { type: String, index: true },
  sealed: Object, subscriptionId: { type: String, default: null } });
// This document is the atomic boundary for grants, resources, receipts and audit.
exports.Profile = model('CareProfile', { _id: String, familyId: { type: String, index: true },
  owner: String, members: { type: [String], index: true }, rev: Number, sealed: Object });

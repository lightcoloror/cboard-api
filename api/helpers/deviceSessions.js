'use strict';
const crypto = require('crypto');
const DeviceSession = require('../models/DeviceSession');
const TTL_SECONDS = 30 * 24 * 60 * 60;

function createDeviceSessions(Model = DeviceSession, now = () => new Date()) {
  return {
    async create(user, label = '图语家设备') {
      const createdAt = now();
      const session = await Model.create({ _id: crypto.randomBytes(24).toString('hex'),
        user, label: String(label).replace(/[\r\n]/g, ' ').slice(0, 100), createdAt,
        expiresAt: new Date(createdAt.getTime() + TTL_SECONDS * 1000), revokedAt: null });
      return session._id;
    },
    async valid(token) {
      if (!token || !/^[a-f0-9]{48}$/.test(token.sid || '')) return false;
      return Boolean(await Model.findOne({ _id: token.sid, user: token.id,
        revokedAt: null, expiresAt: { $gt: now() } }).lean().exec());
    },
    list(user) {
      return Model.find({ user, revokedAt: null, expiresAt: { $gt: now() } })
        .select('_id label createdAt expiresAt').lean().exec();
    },
    revoke(user, id) {
      return Model.updateMany({ user, ...(id ? { _id: id } : {}), revokedAt: null },
        { $set: { revokedAt: now() } }).exec();
    }
  };
}
module.exports = { ...createDeviceSessions(), createDeviceSessions, TTL_SECONDS };

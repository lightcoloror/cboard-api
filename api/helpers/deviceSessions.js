'use strict';
const crypto = require('crypto');
const DeviceSession = require('../models/DeviceSession');
const TTL_SECONDS = 30 * 24 * 60 * 60;
const accountLifecycle = {
  enabled: () => process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true',
  withOpenAccount: (user, callback) => require('./careFamilyLifecycle').createCareFamilyLifecycle().withOpenAccount(String(user), callback),
  async isOpen(user) {
    const state = await require('mongoose').connection.collection('careaccountlifecycles').findOne({ _id: String(user) });
    return !state || state.status === undefined || state.status === 'open';
  }
};

function createDeviceSessions(Model = DeviceSession, now = () => new Date(), lifecycle = accountLifecycle) {
  return {
    async create(user, label = '图语家设备') {
      const createdAt = now();
      const value = { _id: crypto.randomBytes(24).toString('hex'),
        user, label: String(label).replace(/[\r\n]/g, ' ').slice(0, 100), createdAt,
        expiresAt: new Date(createdAt.getTime() + TTL_SECONDS * 1000), revokedAt: null };
      if (lifecycle.enabled()) {
        return lifecycle.withOpenAccount(user, async transaction => {
          const [session] = await Model.create([value], { session: transaction });
          return session._id;
        });
      }
      const session = await Model.create(value);
      return session._id;
    },
    async valid(token) {
      if (!token || !/^[a-f0-9]{48}$/.test(token.sid || '')) return false;
      if (lifecycle.enabled() && !await lifecycle.isOpen(token.id)) return false;
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

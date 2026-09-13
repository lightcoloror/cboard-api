'use strict';
const sessions = require('../helpers/deviceSessions');
exports.listDeviceSessions = async (req, res) => {
  try {
    const items = await sessions.list(req.user.id);
    res.json({ items: items.map(item => ({ id: item._id, label: item.label,
      createdAt: item.createdAt, expiresAt: item.expiresAt, current: item._id === req.auth.sid })) });
  } catch (_) { res.status(503).json({ code: 'SESSION_STORAGE_UNAVAILABLE' }); }
};
exports.revokeDeviceSessions = async (req, res) => {
  const body = req.body || {};
  if (body.all !== true && !/^[a-f0-9]{48}$/.test(body.id || '')) {
    return res.status(400).json({ code: 'INVALID_SESSION' });
  }
  try {
    await sessions.revoke(req.user.id, body.all === true ? null : body.id);
    res.json({ ok: true });
  } catch (_) { res.status(503).json({ code: 'SESSION_STORAGE_UNAVAILABLE' }); }
};

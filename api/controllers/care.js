'use strict';
const { createRuntime } = require('../helpers/careRuntime');
function handler(fn) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (process.env.CARE_COLLABORATION_ENABLED !== 'true') return res.status(503).json({ code: 'CARE_DISABLED' });
    try {
      const result = await fn(createRuntime(), String(req.user.id), req);
      res.status(result && result.conflict ? 409 : 200).json(result);
    } catch (error) {
      res.status(error.status || 503).json({ code: error.code || 'CARE_STORAGE_UNAVAILABLE' });
    }
  };
}
const profile = req => req.swagger.params.profileId.value;
exports.listFamilies = handler((s, u) => s.families(u));
exports.getContext = handler((s, u) => s.context(u));
exports.setContext = handler((s, u, r) => s.context(u, r.body));
exports.getEntitlements = handler((s, u, r) => s.entitlements(u, profile(r)));
exports.transferAdministrator = handler((s, u, r) => s.transferAdmin(u, profile(r), r.body));
exports.listFavorites = handler((s, u, r) => s.favorites(u, profile(r)));
exports.writeFavorite = handler((s, u, r) => s.favorite(u, profile(r), r.body));
exports.writeFavoriteOriginal = handler((s, u, r) => s.favoriteOriginal(u, profile(r), r.body));
exports.migrationPreview = handler((s, u, r) => require('../helpers/careMigrationPreview').previewCareMigration(
  require('mongoose').connection, { id: u, email: r.user.email }));
exports.createFamily = handler((s, u, r) => s.createFamily(u, r.body));
exports.listProfiles = handler((s, u) => s.profiles(u));
exports.createProfile = handler((s, u, r) => s.createProfile(u, r.body));
exports.getProfile = handler((s, u, r) => s.snapshot(u, profile(r), r.query.since === undefined ? -1 : Number(r.query.since)));
exports.command = handler((s, u, r) => s.command(u, profile(r), r.body));
exports.acceptInvitation = handler((s, u, r) => s.accept(u, r.body.token));
exports.getAudit = handler((s, u, r) => s.audit(u, profile(r)));
exports.uploadMedia = handler((s, u, r) => s.upload(u, profile(r), r.body));
exports.getMedia = handler((s, u, r) => s.download(u, profile(r), r.swagger.params.mediaId.value));
exports.deleteMedia = handler((s, u, r) => s.deleteMedia(u, profile(r), r.swagger.params.mediaId.value));

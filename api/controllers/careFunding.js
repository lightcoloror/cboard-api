'use strict';
const runtime = require('../helpers/careBudgetRuntime');
function handler(fn) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (process.env.CARE_NEXT_ENABLED !== 'true') return res.status(503).json({ code: 'CARE_NEXT_DISABLED' });
    try { return res.status(200).json(await fn(req, String(req.user.id))); }
    catch (e) { return res.status(e.status || 503).json({ code: e.code || 'FUNDING_UNAVAILABLE' }); }
  };
}
exports.listFunding = handler(async (req, user) => {
  const profileId = req.query.profileId;
  const docs = await runtime.Funding.find({ members: user }).lean().exec();
  const items = [];
  for (const doc of docs) {
    try {
      await runtime.authorizeProfile(user, profileId, doc._id);
      items.push(await runtime.createRuntime().snapshot(doc._id, user, profileId));
    } catch (e) { if (e.status !== 403) throw e; }
  }
  return { items };
});
exports.delegateFunding = handler(async (req, user) => runtime.createRuntime().delegate(req.swagger.params.fundingId.value, user, req.body));

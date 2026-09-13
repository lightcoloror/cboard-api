'use strict';
// Read-only mapping. No ownership inference from a name, payer or email match
// across accounts. Target selection and import remain explicit user actions.
async function previewCareMigration(db, user) {
  const communicators = await db.collection('communicators').find({ email: user.email, careProfileId: { $exists: false } })
    .project({ _id: 1, boards: 1 }).toArray();
  const boards = await db.collection('boards').find({ email: user.email }).project({ _id: 1 }).toArray();
  return { mode: 'preview-only', accountId: String(user.id),
    requiresTargetSelection: true, ambiguous: communicators.length !== 1,
    communicators: communicators.map(c => ({ sourceId: String(c._id), boardIds: (c.boards || []).map(String), targetProfileId: null })),
    boardIds: boards.map(b => String(b._id)),
    settingsPolicy: 'Select patient preferences explicitly; device voice, layout and keys are excluded.',
    originalDataModified: false };
}
exports.previewCareMigration = previewCareMigration;

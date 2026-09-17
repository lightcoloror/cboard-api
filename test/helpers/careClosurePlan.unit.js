'use strict';

const assert = require('assert').strict;
const { buildCareClosurePlan } = require('../../api/helpers/careClosurePlan');

const encryption = { open: (sealed, context) => {
  if (sealed && (sealed.bad || sealed.state && sealed.state.bad)) throw new Error('bad sealed');
  return sealed && sealed.state;
} };
const family = (id, owner = 'owner-a', state = {}) => ({ _id: id, owner, sealed: { state } });
const profile = (id, familyId, state = {}) => ({ _id: id, familyId, sealed: { state } });
const funding = (id, kind, owner, familyId, state = {}) => ({ _id: id, kind, owner, familyId, sealed: { state } });
const account = (id, state = {}) => ({ _id: id, sealed: { state } });

describe('care closure plan', () => {
  it('collects media and pending records without treating reservation object names as blobs', () => {
    const plan = buildCareClosurePlan({ owner: 'owner-a', familyIds: ['family-a'],
      families: [family('family-a', 'owner-a', { mediaQuota: { reservations: {
        pending: { status: 'reserved', profileId: 'profile-a', mediaId: 'photo-a', objectName: 'candidate.bin' },
        missingObject: { status: 'reserved', profileId: 'profile-a', mediaId: 'photo-b' }
      } } })],
      profiles: [profile('profile-a', 'family-a', { media: {
        photoA: { blob: 'physical-a' },
        released: { deleted: true, storageReleased: true, blob: 'gone' }
      } })], fundings: [], accounts: [account('owner-a', { favorites: { one: { profileId: 'profile-a', value: { sentence: '不要复制' } } }, favoriteAudit: [{ profileId: 'profile-a' }], favoriteReceipts: { one: { result: { resource: { profileId: 'profile-a' } } } } }), account('other-a', { favorites: { other: { profileId: 'other-profile' } } })], encryption });
    assert.deepEqual(plan.media, [{ familyId: 'family-a', profileId: 'profile-a', mediaId: 'photoA', blob: 'physical-a' }]);
    assert.deepEqual(plan.pendingUploads, [
      { familyId: 'family-a', key: 'pending', profileId: 'profile-a', mediaId: 'photo-a', objectName: 'candidate.bin' },
      { familyId: 'family-a', key: 'missingObject', profileId: 'profile-a', mediaId: 'photo-b', objectName: null }
    ]);
    assert.equal(plan.pendingUploads.some(item => item.blob), false);
    assert.deepEqual(plan.relatedAccountIds, ['owner-a']);
  });

  it('filters institution administrators and pending usage by closure scope', () => {
    const plan = buildCareClosurePlan({ owner: 'owner-a', familyIds: ['family-a'], families: [family('family-a')],
      profiles: [profile('profile-a', 'family-a')], fundings: [
        funding('family-funding', 'family', 'owner-a', 'family-a', { receipts: {
          one: { status: 'reserved', actor: 'reader', requestId: 'one', profileId: 'other-profile' }
        } }),
        funding('institution-owned', 'institution', 'owner-a', null, { receipts: {
          two: { status: 'reserved', actor: 'owner-a', requestId: 'two', profileId: 'other-profile' }
        } }),
        funding('institution-other', 'institution', 'other-owner', null, { receipts: {} })
      ], encryption });
    assert.deepEqual(plan.familyFundingIds, ['family-funding']);
    assert.deepEqual(plan.institutionAdminIds, ['institution-owned']);
    assert.deepEqual(plan.pendingUsage, [
      { fundingId: 'family-funding', actor: 'reader', requestId: 'one', profileId: 'other-profile' },
      { fundingId: 'institution-owned', actor: 'owner-a', requestId: 'two', profileId: 'other-profile' }
    ]);
  });

  it('rejects bad ciphertext and cross-family references', () => {
    assert.throws(() => buildCareClosurePlan({ owner: 'owner-a', familyIds: ['family-a'], families: [family('family-a')], profiles: [profile('p', 'family-a', { bad: true })], fundings: [], encryption }), e => e.code === 'CLOSURE_PLAN_UNAVAILABLE');
    assert.throws(() => buildCareClosurePlan({ owner: 'owner-a', familyIds: ['family-a'], families: [family('family-a')], profiles: [profile('p', 'family-b')], fundings: [], encryption }), e => e.code === 'CLOSURE_PLAN_UNAVAILABLE');
  });

  it('returns empty arrays without leaking content', () => {
    const plan = buildCareClosurePlan({ owner: 'owner-a', familyIds: [], families: [], profiles: [], fundings: [], accounts: [], encryption });
    assert.deepEqual(plan, { version: 1, owner: 'owner-a', familyIds: [], profileIds: [], familyFundingIds: [], media: [], pendingUploads: [], pendingUsage: [], institutionAdminIds: [], relatedAccountIds: ['owner-a'] });
  });

  it('scans unrelated funding receipts for owner and closed-profile matches', () => {
    const plan = buildCareClosurePlan({ owner: 'owner-a', familyIds: ['family-a'], families: [family('family-a')],
      profiles: [profile('profile-a', 'family-a')], fundings: [
        funding('other-family', 'family', 'other-owner', 'family-b', { receipts: {
          ownerHit: { status: 'reserved', actor: 'owner-a', requestId: 'owner-hit', profileId: 'other-profile' },
          profileHit: { status: 'reserved', actor: 'other-actor', requestId: 'profile-hit', profileId: 'profile-a' },
          unrelated: { status: 'reserved', actor: 'other-actor', requestId: 'unrelated', profileId: 'other-profile' }
        } }),
        funding('other-institution', 'institution', 'other-owner', null, { receipts: {
          institutionHit: { status: 'reserved', actor: 'owner-a', requestId: 'institution-hit', profileId: 'other-profile' }
        } })
      ], encryption });
    assert.deepEqual(plan.familyFundingIds, []);
    assert.deepEqual(plan.pendingUsage, [
      { fundingId: 'other-family', actor: 'owner-a', requestId: 'owner-hit', profileId: 'other-profile' },
      { fundingId: 'other-family', actor: 'other-actor', requestId: 'profile-hit', profileId: 'profile-a' },
      { fundingId: 'other-institution', actor: 'owner-a', requestId: 'institution-hit', profileId: 'other-profile' }
    ]);
  });

  it('rejects malformed null receipt or quota state deterministically', () => {
    assert.throws(() => buildCareClosurePlan({ owner: 'owner-a', familyIds: ['family-a'], families: [family('family-a')], profiles: [profile('p', 'family-a')], fundings: [funding('f', 'institution', 'other', null, { receipts: null })], encryption }), e => e.code === 'CLOSURE_PLAN_UNAVAILABLE');
    assert.throws(() => buildCareClosurePlan({ owner: 'owner-a', familyIds: ['family-a'], families: [family('family-a', 'owner-a', { mediaQuota: [] })], profiles: [profile('p', 'family-a')], fundings: [], encryption }), e => e.code === 'CLOSURE_PLAN_UNAVAILABLE');
  });
  it('rejects null decoded state, null media and unknown pending statuses without dropping them', () => {
    const base = { owner: 'owner-a', familyIds: ['family-a'], families: [family('family-a')],
      profiles: [profile('p', 'family-a')], fundings: [], encryption };
    for (const invalid of [
      { families: [family('family-a', 'owner-a', null)] },
      { profiles: [profile('p', 'family-a', { media: null })] },
      { families: [family('family-a', 'owner-a', { mediaQuota: null })] },
      { families: [family('family-a', 'owner-a', { mediaQuota: { reservations: { r: { status: 'unknown' } } } })] },
      { fundings: [funding('f', 'institution', 'other', null, { receipts: { r: { status: 'unknown' } } })] }
    ]) assert.throws(() => buildCareClosurePlan({ ...base, ...invalid }), error => error.code === 'CLOSURE_PLAN_UNAVAILABLE');
  });
  it('rejects an oversized plan instead of truncating deletion targets', () => {
    assert.throws(() => buildCareClosurePlan({ owner: 'owner-a', familyIds: ['family-a'], families: [family('family-a')],
      profiles: [profile('p', 'family-a', { media: { huge: { blob: 'x'.repeat(5 * 1024 * 1024) } } })], fundings: [], encryption }),
    error => error.code === 'CLOSURE_PLAN_TOO_LARGE');
  });
});

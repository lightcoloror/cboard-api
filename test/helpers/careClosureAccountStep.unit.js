'use strict';

const chai = require('chai');
const { pruneAccountReferences } = require('../../api/helpers/careClosureAccountStep');

const expect = chai.expect;

async function expectReconciliation(fn) {
  try {
    await fn();
    throw new Error('expected reconciliation failure');
  } catch (error) {
    expect(error.code).to.equal('CLOSURE_RECONCILIATION_REQUIRED');
    expect(error.status).to.equal(503);
  }
}

describe('care closure account pruning', function() {
  it('removes targeted favorites, receipts, audit entries, and selected profile while preserving other families', function() {
    const state = {
      selectedProfileId: 'profile-a',
      favorites: {
        target: { profileId: 'profile-a', value: 'private-a' },
        other: { profileId: 'profile-b', value: 'private-b' }
      },
      favoriteReceipts: {
        target: { result: { resource: { profileId: 'profile-a', mediaId: 'media-a' } } },
        other: { result: { resource: { profileId: 'profile-b', mediaId: 'media-b' } } }
      },
      favoriteAudit: [{ profileId: 'profile-a', action: 'pin' }, { profileId: 'profile-b', action: 'pin' }],
      unrelated: { familyId: 'other-family', keep: true }
    };
    const result = pruneAccountReferences(state, ['profile-a']);
    expect(result.changed).to.equal(true);
    expect(result.state).to.deep.equal({
      selectedProfileId: null,
      favorites: { other: { profileId: 'profile-b', value: 'private-b' } },
      favoriteReceipts: { other: { result: { resource: { profileId: 'profile-b', mediaId: 'media-b' } } } },
      favoriteAudit: [{ profileId: 'profile-b', action: 'pin' }],
      unrelated: { familyId: 'other-family', keep: true }
    });
    expect(state.selectedProfileId).to.equal('profile-a');
  });

  it('is idempotent after the targeted references have been pruned', function() {
    const state = {
      selectedProfileId: null,
      favorites: { other: { profileId: 'profile-b' } },
      favoriteReceipts: { other: { result: { resource: { profileId: 'profile-b' } } } },
      favoriteAudit: [{ profileId: 'profile-b' }]
    };
    const first = pruneAccountReferences(state, ['profile-a']);
    const second = pruneAccountReferences(first.state, ['profile-a']);
    expect(first.changed).to.equal(false);
    expect(second.changed).to.equal(false);
    expect(second.state).to.deep.equal(first.state);
  });

  it('rejects malformed state or profile scopes before producing a partial result', async function() {
    await expectReconciliation(() => pruneAccountReferences(null, ['profile-a']));
    await expectReconciliation(() => pruneAccountReferences({}, ['profile-a', 'profile-a']));
    await expectReconciliation(() => pruneAccountReferences({ selectedProfileId: 'bad id' }, ['profile-a']));
    await expectReconciliation(() => pruneAccountReferences({ favorites: [] }, ['profile-a']));
    await expectReconciliation(() => pruneAccountReferences({ favorites: { x: null } }, ['profile-a']));
    await expectReconciliation(() => pruneAccountReferences({ favorites: { x: { profileId: 'bad id' } } }, ['profile-a']));
    await expectReconciliation(() => pruneAccountReferences({ favoriteReceipts: { x: { result: {} } } }, ['profile-a']));
    await expectReconciliation(() => pruneAccountReferences({ favoriteAudit: [{ profileId: 'bad id' }] }, ['profile-a']));
  });
});

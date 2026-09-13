'use strict';
const assert = require('assert').strict;
const { entitlement, requireEntitlement, relationship, DAY } = require('../../api/helpers/carePolicy');
describe('family subscription and actor policy', () => {
  it('uses exclusive expiry boundaries without disabling offline use', () => {
    const subscription = { startsAt: DAY, expiresAt: 10 * DAY };
    assert.equal(entitlement(subscription, DAY).state, 'active');
    const grace = entitlement(subscription, 10 * DAY);
    assert.equal(grace.state, 'download_grace');
    assert.equal(grace.download, true);
    assert.throws(() => requireEntitlement(grace, 'write'), e => e.code === 'SUBSCRIPTION_EXPIRED');
    const ended = entitlement(subscription, 40 * DAY);
    assert.equal(ended.download, false);
    assert.equal(ended.localExport, true);
    assert.throws(() => requireEntitlement(ended, 'download'), e => e.code === 'DOWNLOAD_PERIOD_ENDED');
    assert.equal(entitlement(null, DAY).download, false);
  });
  it('keeps actor home mode separate from patient data permissions', () => {
    assert.deepEqual(relationship({ role: 'patient', permissions: ['members.manage'] }), { role: 'patient', defaultMode: 'expression' });
    assert.equal(relationship({ role: 'relative' }).defaultMode, 'receiver');
    assert.throws(() => relationship({ role: 'admin' }), e => e.code === 'INVALID_USAGE_ROLE');
  });
});

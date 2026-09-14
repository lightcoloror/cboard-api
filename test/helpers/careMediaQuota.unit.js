'use strict';

const assert = require('assert').strict;
const crypto = require('crypto');
const { createCareCrypto } = require('../../api/helpers/careCrypto');
const {
  createCareMediaQuota,
  resolveCareMediaQuotaConfig
} = require('../../api/helpers/careMediaQuota');

const clone = value => JSON.parse(JSON.stringify(value));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture({ profiles = [] } = {}) {
  const keys = { test: crypto.randomBytes(32).toString('hex') };
  const encryption = createCareCrypto(keys, 'test');
  const family = {
    _id: 'family', rev: 0,
    sealed: encryption.seal({ subscription: null }, 'family:family')
  };
  const docs = profiles.map(({ id, state }) => ({
    _id: id,
    familyId: 'family',
    sealed: encryption.seal(state, `profile:${id}`)
  }));
  let failNextCas = false;
  const store = {
    async getFamily() { return clone(family); },
    async listProfilesByFamily() { return clone(docs); },
    async casFamily(id, rev, update) {
      if (failNextCas) { failNextCas = false; return false; }
      if (id !== family._id || rev !== family.rev) return false;
      Object.assign(family, clone(update)); return true;
    }
  };
  const quota = createCareMediaQuota({
    store, encryption,
    config: resolveCareMediaQuotaConfig({ CARE_FAMILY_MEDIA_QUOTA_BYTES: '10', CARE_FAMILY_MEDIA_QUOTA_MAX_FILES: '2' }),
    now: () => 1000
  });
  return { family, encryption, quota, setCasConflict: () => { failNextCas = true; } };
}

describe('care family media quota', function() {
  it('does not silently grant a quota when the deployment configuration is absent', async function() {
    const f = fixture();
    const unavailable = createCareMediaQuota({
      store: { getFamily: async () => ({ _id: 'family', rev: 0, sealed: f.family.sealed }) },
      encryption: f.encryption,
      config: resolveCareMediaQuotaConfig({})
    });
    await assert.rejects(
      unavailable.ensureInitialized('family'),
      error => error.code === 'MEDIA_QUOTA_NOT_CONFIGURED'
    );
  });

  it('initializes from all live and unreconciled legacy deleted media, never zero', async function() {
    const f = fixture({ profiles: [
      { id: 'one', state: { media: { live: { size: 3 }, oldDeleted: { size: 2, deleted: true } } } },
      { id: 'two', state: { media: { released: { size: 4, deleted: true, storageReleased: true } } } }
    ] });
    const initialized = await f.quota.ensureInitialized('family');
    assert.equal(initialized.quota.usedBytes, 5);
    assert.equal(initialized.quota.usedFiles, 2);
  });

  it('requires reconciliation when a legacy entry has no reliable byte count', async function() {
    const f = fixture({ profiles: [{ id: 'one', state: { media: { legacy: { deleted: true } } } }] });
    await assert.rejects(
      f.quota.ensureInitialized('family'),
      error => error.code === 'MEDIA_QUOTA_RECONCILIATION_REQUIRED'
    );
  });

  it('fails closed for an unknown or corrupt persisted quota state', async function() {
    const f = fixture();
    const state = f.encryption.open(f.family.sealed, 'family:family');
    state.mediaQuota = { version: 99, usedBytes: 0 };
    f.family.sealed = f.encryption.seal(state, 'family:family');
    await assert.rejects(f.quota.ensureInitialized('family'), error => error.code === 'MEDIA_QUOTA_RECONCILIATION_REQUIRED');
    state.mediaQuota = { version: 1, limitBytes: 10, maxFiles: 2, usedBytes: -1, usedFiles: 0, reservedBytes: 0, reservedFiles: 0, reservations: {}, released: {} };
    f.family.sealed = f.encryption.seal(state, 'family:family');
    await assert.rejects(f.quota.ensureInitialized('family'), error => error.code === 'MEDIA_QUOTA_RECONCILIATION_REQUIRED');
  });

  it('uses family CAS so concurrent same-media reservations have one writer and one pending result', async function() {
    const f = fixture();
    const request = { familyId: 'family', profileId: 'profile', mediaId: 'photo', sha256: sha('photo'), size: 6 };
    const [first, second] = await Promise.all([f.quota.reserve(request), f.quota.reserve(request)]);
    assert.equal([first, second].filter(value => value.pending).length, 1);
    assert.equal([first, second].filter(value => !value.pending).length, 1);
    const state = f.encryption.open(f.family.sealed, 'family:family').mediaQuota;
    assert.equal(state.reservedBytes, 6);
    assert.equal(Object.keys(state.reservations).length, 1);
  });

  it('retries initialization CAS before reserving and rejects capacity overrun', async function() {
    const f = fixture();
    f.setCasConflict();
    await f.quota.reserve({ familyId: 'family', profileId: 'profile', mediaId: 'one', sha256: sha('one'), size: 6 });
    await assert.rejects(
      f.quota.reserve({ familyId: 'family', profileId: 'profile', mediaId: 'two', sha256: sha('two'), size: 5 }),
      error => error.code === 'FAMILY_MEDIA_QUOTA_EXCEEDED'
    );
  });

  it('limits tiny media by object count as well as logical payload bytes', async function() {
    const f = fixture();
    await f.quota.reserve({ familyId: 'family', profileId: 'profile', mediaId: 'one', sha256: sha('one'), size: 1 });
    await f.quota.reserve({ familyId: 'family', profileId: 'profile', mediaId: 'two', sha256: sha('two'), size: 1 });
    await assert.rejects(
      f.quota.reserve({ familyId: 'family', profileId: 'profile', mediaId: 'three', sha256: sha('three'), size: 1 }),
      error => error.code === 'FAMILY_MEDIA_QUOTA_EXCEEDED'
    );
  });

  it('retains a committed receipt so a late request cannot reserve another blob', async function() {
    const f = fixture();
    const request = { familyId: 'family', profileId: 'profile', mediaId: 'photo', sha256: sha('photo'), size: 6 };
    const reservation = await f.quota.reserve(request);
    assert.equal((await f.quota.commit({ familyId: 'family', key: reservation.key })).committed, true);
    assert.equal((await f.quota.commit({ familyId: 'family', key: reservation.key })).committed, false);
    const late = await f.quota.reserve(request);
    assert.equal(late.committed, true);
    assert.equal((await f.quota.release(request)).released, true);
    assert.equal((await f.quota.release(request)).released, false);
    await assert.rejects(f.quota.reserve(request), error => error.code === 'MEDIA_ID_REUSED');
    const other = await f.quota.reserve({ familyId: 'family', profileId: 'profile', mediaId: 'other', sha256: sha('other'), size: 3 });
    assert.equal((await f.quota.cancel({ familyId: 'family', key: other.key })).cancelled, true);
    assert.equal((await f.quota.cancel({ familyId: 'family', key: other.key })).cancelled, false);
    const state = f.encryption.open(f.family.sealed, 'family:family').mediaQuota;
    assert.equal(state.usedBytes, 0);
    assert.equal(state.reservedBytes, 0);
  });
});

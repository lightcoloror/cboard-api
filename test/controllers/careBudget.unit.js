'use strict';
const assert = require('assert').strict;
const crypto = require('crypto');
const { createCareCrypto } = require('../../api/helpers/careCrypto');
const { createCareBudget } = require('../../api/helpers/careBudget');
const { DAY } = require('../../api/helpers/carePolicy');
const clone = v => v && JSON.parse(JSON.stringify(v));
function fixture() {
  const docs = {}; const casContexts = []; let clock = DAY;
  const encryption = createCareCrypto({ test: crypto.randomBytes(32).toString('hex') }, 'test');
  const store = {
    get: async id => clone(docs[id]),
    create: async d => { if (docs[d._id]) return false; docs[d._id] = clone(d); return true; },
    cas: async (id, rev, value, context = {}) => { casContexts.push(clone(context)); if (docs[id].rev !== rev) return false; docs[id] = { ...docs[id], ...clone(value) }; return true; }
  };
  const options = { store, encryption, now: () => clock };
  return { options, service: createCareBudget(options), time: v => { clock = v; }, docs, casContexts };
}
const request = (requestId, units = 20) => ({ actor: 'therapist', profileId: 'patient', requestId, units, fingerprint: 'a'.repeat(64) });
async function setup(f) {
  await f.service.provision('family', { owner: 'owner', kind: 'family', weeklyLimit: 100, startsAt: DAY, expiresAt: 100 * DAY });
  await f.service.delegate('family', 'owner', { member: 'therapist', limit: 30, profileIds: ['patient'] });
}
describe('durable family and institutional weekly AI budget', () => {
  it('passes operation-specific internal CAS contexts without mixing reserve and settlement', async () => {
    const f = fixture(); await setup(f);
    assert.deepEqual(f.casContexts[0], { mode: 'delegate', actor: 'owner', targetMember: 'therapist', revoke: false });

    await f.service.reserve('family', request('context-check'));
    assert.deepEqual(f.casContexts.at(-1), { mode: 'reserve', actor: 'therapist', profileId: 'patient' });

    await f.service.settle('family', 'therapist', 'context-check', 7);
    assert.deepEqual(f.casContexts.at(-1), { mode: 'settle', actor: 'therapist', requestId: 'context-check' });
    assert.notDeepEqual(f.casContexts.at(-2), f.casContexts.at(-1));
  });

  it('atomically enforces delegated caps across concurrent requests', async () => {
    const f = fixture(); await setup(f);
    const results = await Promise.allSettled([f.service.reserve('family', request('one')), f.service.reserve('family', request('two'))]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'DELEGATED_QUOTA_EXCEEDED');
    assert.equal((await f.service.snapshot('family', 'therapist', 'patient')).weeklyUsed, 20);
  });
  it('deduplicates reserve and settlement after restart without refunding twice', async () => {
    const f = fixture(); await setup(f);
    await f.service.reserve('family', request('one'));
    const restarted = createCareBudget(f.options);
    assert.equal((await restarted.reserve('family', request('one'))).duplicate, true);
    await restarted.settle('family', 'therapist', 'one', 7);
    await restarted.settle('family', 'therapist', 'one', 7);
    assert.equal((await restarted.snapshot('family', 'therapist', 'patient')).weeklyUsed, 7);
    await assert.rejects(restarted.settle('family', 'therapist', 'one', 0), e => e.code === 'SETTLEMENT_MISMATCH');
    await assert.rejects(restarted.reserve('family', { ...request('one'), fingerprint: 'b'.repeat(64) }), e => e.code === 'USAGE_ID_REUSED');
  });
  it('resets every seven days from activation and never carries a late refund into the new week', async () => {
    const f = fixture(); await setup(f); await f.service.reserve('family', request('one'));
    f.time(8 * DAY);
    assert.equal((await f.service.snapshot('family', 'therapist', 'patient')).weeklyUsed, 0);
    await f.service.settle('family', 'therapist', 'one', 0);
    assert.equal((await f.service.snapshot('family', 'therapist', 'patient')).available, 100);
    await f.service.renew('family', 200 * DAY);
    assert.equal((await f.service.snapshot('family', 'therapist', 'patient')).resetAt, 15 * DAY);
  });
  it('separates pack types, enforces purchased expiry, and requires explicit grant policy', async () => {
    const f = fixture(); await setup(f);
    await assert.rejects(f.service.addPack('family', { id: 'trial', type: 'trial', amount: 10, startsAt: DAY }), e => e.code === 'PACK_POLICY_NOT_CONFIGURED');
    await f.service.addPack('family', { id: 'buy', type: 'purchased', amount: 50, startsAt: DAY, expiresAt: 999 * DAY });
    assert.equal((await f.service.snapshot('family', 'therapist', 'patient')).packs[0].expiresAt, 31 * DAY);
    f.time(31 * DAY);
    assert.equal((await f.service.snapshot('family', 'therapist', 'patient')).available, 100);
  });
  it('checks scope and revocation even for duplicate requests and has no source fallback', async () => {
    const f = fixture(); await setup(f); await f.service.reserve('family', request('one'));
    await assert.rejects(f.service.reserve('family', { ...request('two'), profileId: 'other' }), e => e.code === 'FUNDING_ACCESS_DENIED');
    await f.service.delegate('family', 'owner', { member: 'therapist', limit: 30, profileIds: ['patient'], revoked: true });
    assert.deepEqual(f.casContexts.at(-1), { mode: 'delegate', actor: 'owner', targetMember: 'therapist', revoke: true });
    await assert.rejects(f.service.reserve('family', request('one')), e => e.code === 'FUNDING_ACCESS_DENIED');
    await assert.rejects(f.service.reserve('unknown', request('one')), e => e.code === 'FUNDING_ACCESS_DENIED');
  });

  it('commits completion and settlement atomically and makes concurrent completion idempotent', async () => {
    const f = fixture(); await setup(f); await f.service.reserve('family', request('completion'));
    const response = { status: 200, body: { candidates: ['我想喝水'] } };
    await Promise.all([f.service.complete('family', 'therapist', 'completion', 7, response),
      f.service.complete('family', 'therapist', 'completion', 7, response)]);
    const restarted = createCareBudget(f.options);
    const duplicate = await restarted.reserve('family', request('completion'));
    assert.deepEqual(duplicate.response, response); assert.equal(duplicate.actual, 7);
    assert.equal((await restarted.snapshot('family', 'therapist', 'patient')).weeklyUsed, 7);
    await assert.rejects(restarted.complete('family', 'therapist', 'completion', 7,
      { status: 200, body: { candidates: ['different'] } }), e => e.code === 'AI_RESPONSE_MISMATCH');
    await assert.rejects(restarted.complete('family', 'therapist', 'completion', 0, response), e => e.code === 'SETTLEMENT_MISMATCH');
  });
  it('rejects oversized or header-bearing results before settlement and keeps the reservation', async () => {
    const f = fixture(); await setup(f); await f.service.reserve('family', request('oversized'));
    await assert.rejects(f.service.complete('family', 'therapist', 'oversized', 7,
      { status: 200, body: { text: 'x'.repeat(65536) } }), e => e.code === 'AI_RESPONSE_TOO_LARGE');
    await assert.rejects(f.service.complete('family', 'therapist', 'oversized', 7,
      { status: 200, body: {}, headers: { Authorization: 'synthetic-secret' } }), e => e.code === 'AI_RESPONSE_NOT_PERSISTABLE');
    assert.equal((await f.service.snapshot('family', 'therapist', 'patient')).weeklyUsed, 20);
    assert.equal((await f.service.snapshot('family', 'therapist', 'patient')).pendingRequests.length, 1);
  });
  it('removes expired completion bodies but keeps the financial receipt and never restores the body', async () => {
    const f = fixture(); await setup(f); await f.service.reserve('family', request('expiry'));
    const response = { status: 200, body: { candidates: ['我想喝水'] } };
    await f.service.complete('family', 'therapist', 'expiry', 7, response);
    f.time(2 * DAY);
    const duplicate = await f.service.reserve('family', request('expiry'));
    assert.equal(duplicate.status, 'settled'); assert.equal(duplicate.response, undefined);
    await f.service.complete('family', 'therapist', 'expiry', 7, response);
    assert.equal((await f.service.reserve('family', request('expiry'))).response, undefined);
    assert.equal((await f.service.snapshot('family', 'therapist', 'patient')).weeklyUsed, 7);
  });
});

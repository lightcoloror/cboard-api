'use strict';
const assert = require('assert').strict;
const { createDeviceSessions } = require('../../api/helpers/deviceSessions');
describe('independent device sessions', () => {
  it('creates sessions under the account transaction and rejects tokens while closing', async () => {
    let open = true, creates = 0, receivedSession;
    const transaction = { synthetic: true };
    const lifecycle = { enabled: () => true, isOpen: async () => open,
      async withOpenAccount(user, callback) {
        if (!open) throw Object.assign(new Error('ACCOUNT_CLOSING'), { code: 'ACCOUNT_CLOSING' });
        return callback(transaction);
      } };
    const Model = { async create(values, options) { creates++; receivedSession = options.session; return values; },
      findOne: () => ({ lean: () => ({ exec: async () => ({}) }) }) };
    const sessions = createDeviceSessions(Model, () => new Date(), lifecycle);
    const sid = await sessions.create('userA');
    assert.equal(receivedSession, transaction);
    assert.equal(await sessions.valid({ id: 'userA', sid }), true);
    open = false;
    assert.equal(await sessions.valid({ id: 'userA', sid }), false);
    await assert.rejects(sessions.create('userA'), error => error.code === 'ACCOUNT_CLOSING');
    assert.equal(creates, 1);
  });

  it('revokes exactly the selected user device, rejects legacy/expired tokens and supports all-device logout', async () => {
    const rows = [];
    let clock = new Date();
    const match = (r, q) => Object.entries(q).every(([k, v]) => v && v.$gt ? r[k] > v.$gt : String(r[k]) === String(v));
    const Model = {
      create: async r => { rows.push(r); return r; },
      findOne: q => ({ lean: () => ({ exec: async () => rows.find(r => match(r, q)) }) }),
      updateMany: (q, update) => ({ exec: async () => { rows.filter(r => match(r, q)).forEach(r => Object.assign(r, update.$set)); } })
    };
    const s = createDeviceSessions(Model, () => clock);
    const a = await s.create('userA', 'web'), b = await s.create('userA', 'wechat'), c = await s.create('userB', 'web');
    assert.equal(await s.valid({ id: 'userA' }), false);
    assert.equal(await s.valid({ id: 'userB', sid: a }), false);
    assert(await s.valid({ id: 'userA', sid: a }));
    await s.revoke('userA', a);
    assert.equal(await s.valid({ id: 'userA', sid: a }), false);
    assert(await s.valid({ id: 'userA', sid: b }));
    await s.revoke('userA');
    assert.equal(await s.valid({ id: 'userA', sid: b }), false);
    assert(await s.valid({ id: 'userB', sid: c }));
    clock = new Date(clock.getTime() + 31 * 86400000);
    assert.equal(await s.valid({ id: 'userB', sid: c }), false);
  });
});

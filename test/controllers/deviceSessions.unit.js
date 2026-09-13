'use strict';
const assert = require('assert').strict;
const { createDeviceSessions } = require('../../api/helpers/deviceSessions');
describe('independent device sessions', () => {
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

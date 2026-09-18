'use strict';
const { expect } = require('chai');
const mockery = require('mockery');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const limits = require('../../api/helpers/authRequestRateLimit');
const entry = require.resolve('../../api/controllers/care');
const YAML = require('yamljs');

describe('family and patient creation throttling', function() {
  let original, controller, writes, policies;
  beforeEach(function() {
    original = process.env.CARE_COLLABORATION_ENABLED; process.env.CARE_COLLABORATION_ENABLED = 'true';
    writes = []; policies = {};
    for (const operation of ['familyCreate', 'profileCreate', 'invitationAccept']) policies[operation] = {
      emailHourly: new RateLimiterMemory({ points: 1, duration: 3600 }),
      ipHourly: new RateLimiterMemory({ points: 2, duration: 3600 })
    };
    mockery.enable({ warnOnUnregistered: false });
    mockery.registerMock('../helpers/careRuntime', { createRuntime: () => ({
      createFamily: async (u, body) => { writes.push(['family', u, body]); return { id: 'family' }; },
      createProfile: async (u, body) => { writes.push(['profile', u, body]); return { id: 'profile' }; },
      accept: async (u, token) => { writes.push(['invitation', u, token]); return { id: 'profile' }; },
      families: async () => []
    }) });
    mockery.registerMock('../helpers/authRequestRateLimit', { ...limits, getAuthRequestLimiters: op => policies[op] });
    delete require.cache[entry]; controller = require(entry);
  });
  afterEach(function() {
    delete require.cache[entry]; mockery.deregisterAll(); mockery.disable();
    if (original === undefined) delete process.env.CARE_COLLABORATION_ENABLED; else process.env.CARE_COLLABORATION_ENABLED = original;
  });
  async function call(method, user = 'owner', ip = '192.0.2.1') {
    const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; },
      status(s) { this.code = s; return this; }, json(v) { this.body = v; return this; } };
    await controller[method]({ user: { id: user }, ip,
      body: method === 'acceptInvitation' ? { token: 'synthetic-invitation' } : { name: 'synthetic' } }, res);
    return res;
  }
  for (const [method, operation, code] of [
    ['createFamily', 'familyCreate', 'CARE_FAMILY_CREATE'],
    ['createProfile', 'profileCreate', 'CARE_PROFILE_CREATE'],
    ['acceptInvitation', 'invitationAccept', 'CARE_INVITATION_ACCEPT']
  ]) {
    it(`${method} stops repeated account requests before writes and emits retry information`, async function() {
      expect((await call(method)).code).to.equal(200);
      const blocked = await call(method, 'owner', '192.0.2.2');
      expect(blocked.code).to.equal(429); expect(blocked.body.code).to.equal(`${code}_RATE_LIMITED`);
      expect(Number(blocked.headers['Retry-After'])).to.be.greaterThan(0);
      expect(writes).to.have.length(1);
    });
    it(`${method} aggregates distinct accounts by IP`, async function() {
      expect((await call(method, 'a')).code).to.equal(200);
      expect((await call(method, 'b')).code).to.equal(200);
      expect((await call(method, 'c')).code).to.equal(429);
      expect(writes).to.have.length(2);
    });
    it(`${method} fails closed if persistent limit storage is unavailable`, async function() {
      policies[operation].ipHourly = { consume: async () => { throw new Error('private database error'); } };
      const failed = await call(method);
      expect(failed.code).to.equal(503); expect(failed.body.code).to.equal(`${code}_RATE_LIMIT_UNAVAILABLE`);
      expect(writes).to.have.length(0);
    });
  }
  it('keeps read-only family access independent from creation limits and honors the feature gate', async function() {
    await call('createFamily'); await call('createFamily');
    expect((await call('listFamilies')).code).to.equal(200);
    process.env.CARE_COLLABORATION_ENABLED = 'false';
    expect((await call('createProfile')).body.code).to.equal('CARE_DISABLED');
    expect(writes).to.have.length(1);
  });
  it('documents 429 with Retry-After for creation and invitation acceptance endpoints', function() {
    const spec = YAML.load('./api/swagger/swagger.yaml');
    for (const path of ['/care/families', '/care/profiles', '/care/invitations/accept']) {
      expect(spec.paths[path].post.responses['429'].headers['Retry-After'].type).to.equal('integer');
    }
  });
});

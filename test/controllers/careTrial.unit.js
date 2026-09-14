'use strict';

const assert = require('assert').strict;
const YAML = require('yamljs');
const { createCareTrialController } = require('../../api/controllers/careTrial');

const policy = { version: 'public-v1', trialUnits: 12, weeklyLimit: 4, trialDurationMs: 3000, subscriptionDurationMs: 7000 };
function response() { return { statusCode: 0, body: null, headers: {}, set(name, value) { this.headers[name] = value; return this; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } }; }
function request({ user = { id: 'user-a' }, familyId = 'family-a' } = {}) { return { user, body: { familyId }, ip: '203.0.113.8' }; }
function fixture(overrides = {}) {
  const calls = { limits: [], claims: [] };
  const controller = createCareTrialController({ env: { CARE_NEXT_ENABLED: 'true', CARE_PUBLIC_TRIAL_ENABLED: 'true' }, policyReader: () => policy,
    limiters: { synthetic: true }, consumeLimits: async value => calls.limits.push(value),
    runtimeFactory: () => ({ claim: async (accountId, familyId) => { calls.claims.push({ accountId, familyId }); return { claimId: 'trial-a', fundingId: 'funding-a', status: 'complete' }; } }), ...overrides });
  return { controller, calls };
}

describe('care trial controller', function() {
  it('keeps the Swagger request surface to familyId only and requires Bearer auth', function() {
    const spec = YAML.load('api/swagger/swagger.yaml'); const operation = spec.paths['/care/trial-claims'].post;
    assert.deepEqual(operation.security, [{ Bearer: [] }]);
    const schema = operation.parameters[0].schema;
    assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.required, ['familyId']); assert.deepEqual(Object.keys(schema.properties), ['familyId']);
  });

  it('returns 401 before feature, policy, limiter, or claim work when auth is absent', async function() {
    const f = fixture(); const res = response(); await f.controller(request({ user: null }), res);
    assert.equal(res.statusCode, 401); assert.equal(res.body.code, 'LOGIN_REQUIRED'); assert.deepEqual(f.calls, { limits: [], claims: [] });
  });

  it('returns disabled or unconfigured responses before limiter and claim writes', async function() {
    const disabled = fixture({ env: { CARE_NEXT_ENABLED: 'false', CARE_PUBLIC_TRIAL_ENABLED: 'true' } }); const disabledRes = response();
    await disabled.controller(request(), disabledRes); assert.equal(disabledRes.body.code, 'CARE_TRIAL_DISABLED'); assert.deepEqual(disabled.calls, { limits: [], claims: [] });
    const missing = fixture({ policyReader: () => null }); const missingRes = response(); await missing.controller(request(), missingRes);
    assert.equal(missingRes.body.code, 'TRIAL_NOT_CONFIGURED'); assert.deepEqual(missing.calls, { limits: [], claims: [] });
  });

  it('uses only req.user account identity, returns idempotent receipts, and propagates owner denial', async function() {
    const f = fixture(); const first = response(); const replay = response(); await f.controller(request(), first); await f.controller(request(), replay);
    assert.equal(first.statusCode, 200); assert.deepEqual(replay.body, first.body); assert.deepEqual(f.calls.claims, [{ accountId: 'user-a', familyId: 'family-a' }, { accountId: 'user-a', familyId: 'family-a' }]);
    const denied = fixture({ runtimeFactory: () => ({ claim: async () => { throw Object.assign(new Error('owner'), { status: 403, code: 'FAMILY_OWNER_REQUIRED' }); } }) }); const deniedRes = response();
    await denied.controller(request(), deniedRes); assert.equal(deniedRes.statusCode, 403); assert.equal(deniedRes.body.code, 'FAMILY_OWNER_REQUIRED');
  });

  it('returns retry-after for limiter 429 and fails closed for limiter errors', async function() {
    const limited = fixture({ consumeLimits: async () => { throw Object.assign(new Error('limited'), { status: 429, code: 'CARE_TRIAL_RATE_LIMITED', retryAfter: 60 }); } }); const limitedRes = response();
    await limited.controller(request(), limitedRes); assert.equal(limitedRes.statusCode, 429); assert.equal(limitedRes.headers['Retry-After'], '60'); assert.equal(limitedRes.body.code, 'CARE_TRIAL_RATE_LIMITED');
    const unavailable = fixture({ consumeLimits: async () => { throw Object.assign(new Error('down'), { status: 503, code: 'CARE_TRIAL_RATE_LIMIT_UNAVAILABLE' }); } }); const unavailableRes = response();
    await unavailable.controller(request(), unavailableRes); assert.equal(unavailableRes.statusCode, 503); assert.equal(unavailableRes.body.code, 'CARE_TRIAL_RATE_LIMIT_UNAVAILABLE'); assert.deepEqual(unavailable.calls.claims, []);
  });

  it('lazily initializes the Mongo limiter runtime once after gates pass', async function() {
    let initialized = 0; const controller = createCareTrialController({ env: { CARE_NEXT_ENABLED: 'true', CARE_PUBLIC_TRIAL_ENABLED: 'true' }, policyReader: () => policy,
      limiterRuntimeFactory: () => { initialized++; return { limiters: { synthetic: true } }; }, consumeLimits: async () => {},
      runtimeFactory: () => ({ claim: async () => ({ claimId: 'trial-a', fundingId: 'funding-a', status: 'complete' }) }) });
    await controller(request(), response()); await controller(request(), response()); assert.equal(initialized, 1);
  });
});

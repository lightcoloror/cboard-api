'use strict';
const assert = require('assert').strict;
const { EventEmitter } = require('events');
const { createCareAiMetering, OPERATIONS } = require('../../api/helpers/careAiMetering');
function fixture() {
  const calls = []; let receipt = null;
  const service = {
    reserve: async () => receipt ? { ...receipt, duplicate: true } : (receipt = { status: 'reserved' }),
    settle: async (funding, actor, request, units) => { calls.push(units); receipt.status = units ? 'settled' : 'released'; }
  };
  const middleware = createCareAiMetering({ env: { CARE_NEXT_ENABLED: 'true', CARE_AI_PRICE_POLICY: JSON.stringify({ generateCommunicationSentences: { reservationUnits: 10, fixedUnits: 1, tokensPerUnit: 10 } }) },
    runtimeFactory: () => service, authorizeProfile: async () => {} });
  const req = { user: { id: 'actor' }, headers: { 'x-care-funding-id': 'fund', 'x-care-profile-id': 'patient', 'idempotency-key': 'request' },
    swagger: { operation: { operationId: 'generateCommunicationSentences' } }, body: { labels: ['合成'] } };
  const res = new EventEmitter(); res.statusCode = 200; res.set = () => res;
  res.status = code => { res.statusCode = code; return res; }; res.json = value => { res.body = value; return res; };
  return { middleware, req, res, calls };
}
describe('AI quota request lifecycle', () => {
  it('refuses every online AI operation when trial and family billing flags disagree', async () => {
    for (const enabled of [undefined, 'false']) {
      const middleware = createCareAiMetering({ env: {
        CARE_PUBLIC_TRIAL_ENABLED: 'true', CARE_NEXT_ENABLED: enabled
      }, runtimeFactory: () => assert.fail('must not reserve'),
      authorizeProfile: () => assert.fail('must not authorize') });
      for (const operationId of OPERATIONS) {
        const f = fixture();
        const headers = {};
        f.res.set = (key, value) => { headers[key] = value; return f.res; };
        f.req.swagger.operation.operationId = operationId;
        await middleware(f.req, f.res, () => assert.fail('must not call provider'));
        assert.equal(f.res.statusCode, 503);
        assert.equal(f.res.body.code, 'CARE_TRIAL_CONFIGURATION_INVALID');
        assert.equal(headers['Cache-Control'], 'no-store');
      }
    }
  });
  it('preserves non-AI requests and explicitly non-trial legacy behavior', async () => {
    for (const [env, operationId] of [
      [{ CARE_PUBLIC_TRIAL_ENABLED: 'true' }, 'health'],
      [{ CARE_PUBLIC_TRIAL_ENABLED: 'false' }, 'generateCommunicationSentences']
    ]) {
      const f = fixture(); let continued = false;
      f.req.swagger.operation.operationId = operationId;
      await createCareAiMetering({ env })(f.req, f.res, () => { continued = true; });
      assert.equal(continued, true);
    }
  });
  it('releases validation or configuration failures before any provider execution', async () => {
    const f = fixture(); await f.middleware(f.req, f.res, () => {});
    f.res.statusCode = 503; f.res.emit('finish'); await Promise.resolve();
    assert.deepEqual(f.calls, [0]);
  });
  it('retains uncertain provider timeouts for explicit reconciliation', async () => {
    const f = fixture(); await f.middleware(f.req, f.res, () => {});
    f.req.careUsage.markProviderStarted(); f.res.statusCode = 504; f.res.emit('finish');
    assert.deepEqual(f.calls, []);
    await f.middleware(f.req, f.res, () => assert.fail('provider must not execute twice'));
    assert.equal(f.res.body.code, 'AI_REQUEST_PENDING_RECONCILIATION');
  });
  it('settles observed usage once and rejects an identical completed request', async () => {
    const f = fixture(); await f.middleware(f.req, f.res, () => {});
    f.req.careUsage.markProviderStarted(); await f.req.careUsage.observe({ totalTokens: 23 });
    f.res.emit('finish'); await Promise.resolve(); assert.deepEqual(f.calls, [3]);
    await f.middleware(f.req, f.res, () => assert.fail('provider must not execute twice'));
    assert.equal(f.res.body.code, 'AI_REQUEST_ALREADY_COMPLETED');
  });
  it('rejects missing explicit funding before reserving any balance', async () => {
    const f = fixture(); delete f.req.headers['x-care-funding-id'];
    await f.middleware(f.req, f.res, () => assert.fail('missing funding'));
    assert.equal(f.res.body.code, 'EXPLICIT_FUNDING_REQUIRED'); assert.deepEqual(f.calls, []);
  });
});

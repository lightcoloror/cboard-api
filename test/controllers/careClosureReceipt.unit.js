'use strict';

const chai = require('chai');
const {
  createCareClosureReceiptController,
  featureEnabled
} = require('../../api/controllers/careClosureReceipt');

const expect = chai.expect;
const OWNER = '0123456789abcdef01234567';
const SECRET = 'a'.repeat(64);

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function expectCode(promise, code, status) {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error.code).to.equal(code);
    if (status !== undefined) expect(error.status).to.equal(status);
  }
}

describe('care closure receipt controller', function() {
  it('requires both feature flags', function() {
    const previousCollaboration = process.env.CARE_COLLABORATION_ENABLED;
    const previousLifecycle = process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    try {
      for (const collaboration of ['false', 'true']) {
        for (const lifecycle of ['false', 'true']) {
          process.env.CARE_COLLABORATION_ENABLED = collaboration;
          process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = lifecycle;
          expect(featureEnabled()).to.equal(collaboration === 'true' && lifecycle === 'true');
        }
      }
    } finally {
      if (previousCollaboration === undefined) delete process.env.CARE_COLLABORATION_ENABLED;
      else process.env.CARE_COLLABORATION_ENABLED = previousCollaboration;
      if (previousLifecycle === undefined) delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
      else process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = previousLifecycle;
    }
  });

  it('prepares a receipt for the authenticated owner after closurePrepare limiting', async function() {
    const limitCalls = [];
    const receiptCalls = [];
    const controller = createCareClosureReceiptController({
      enabled: true,
      consumeLimits: async input => { limitCalls.push(input); },
      receipt: { async prepare(owner) { receiptCalls.push(owner); return { receiptId: owner, secret: SECRET, expiresAt: 99 }; } }
    });
    const res = response();

    await controller.prepareClosureReceipt({ user: { id: OWNER }, body: { owner: 'forged-owner' }, ip: '198.51.100.4' }, res);

    expect(res.statusCode).to.equal(201);
    expect(res.body).to.deep.equal({ receiptId: OWNER, secret: SECRET, expiresAt: 99 });
    expect(receiptCalls).to.deep.equal([OWNER]);
    expect(limitCalls).to.deep.equal([{ limiters: undefined, operation: 'closurePrepare', email: OWNER, ip: '198.51.100.4' }]);
  });

  it('rejects anonymous preparation before limiter or receipt access', async function() {
    let limitCalls = 0;
    let receiptCalls = 0;
    const controller = createCareClosureReceiptController({
      enabled: true,
      consumeLimits: async () => { limitCalls += 1; },
      receipt: { async prepare() { receiptCalls += 1; } }
    });
    const res = response();

    await controller.prepareClosureReceipt({ user: null, ip: '198.51.100.4' }, res);

    expect(res.statusCode).to.equal(401);
    expect(res.body).to.deep.equal({ code: 'LOGIN_REQUIRED' });
    expect(limitCalls).to.equal(0);
    expect(receiptCalls).to.equal(0);
  });

  it('inspects only a valid capability after closureStatus limiting', async function() {
    const limitCalls = [];
    const receiptCalls = [];
    const controller = createCareClosureReceiptController({
      enabled: true,
      consumeLimits: async input => { limitCalls.push(input); },
      receipt: { async inspect(receiptId, secret) { receiptCalls.push({ receiptId, secret }); return { status: 'prepared', accountDeleted: false }; } }
    });
    const res = response();

    await controller.inspectClosureReceipt({ body: { receiptId: OWNER, secret: SECRET }, ip: '203.0.113.9' }, res);

    expect(res.statusCode).to.equal(200);
    expect(res.body).to.deep.equal({ status: 'prepared', accountDeleted: false });
    expect(receiptCalls).to.deep.equal([{ receiptId: OWNER, secret: SECRET }]);
    expect(limitCalls).to.deep.equal([{ limiters: undefined, operation: 'closureStatus', email: OWNER, ip: '203.0.113.9' }]);
  });

  it('rate limits malformed capability probes before credential validation', async function() {
    let receiptCalls = 0;
    const limited = Object.assign(new Error('rate limit internals'), {
      code: 'CLOSURE_STATUS_RATE_LIMITED', status: 429, retryAfter: 17
    });
    const controller = createCareClosureReceiptController({
      enabled: true,
      consumeLimits: async () => { throw limited; },
      receipt: { async inspect() { receiptCalls += 1; } }
    });
    const res = response();

    await controller.inspectClosureReceipt({ body: { receiptId: 'bad', secret: 'bad' }, ip: '203.0.113.9' }, res);

    expect(res.statusCode).to.equal(429);
    expect(res.headers['Retry-After']).to.equal('17');
    expect(res.body).to.deep.equal({ code: 'CLOSURE_STATUS_RATE_LIMITED' });
    expect(receiptCalls).to.equal(0);
  });

  it('returns 503 for limiter failure without accessing receipt data', async function() {
    let receiptCalls = 0;
    const unavailable = Object.assign(new Error('Mongo details'), {
      code: 'CLOSURE_STATUS_RATE_LIMIT_UNAVAILABLE', status: 503
    });
    const controller = createCareClosureReceiptController({
      enabled: true,
      consumeLimits: async () => { throw unavailable; },
      receipt: { async inspect() { receiptCalls += 1; } }
    });
    const res = response();

    await controller.inspectClosureReceipt({ body: { receiptId: OWNER, secret: SECRET }, ip: '203.0.113.9' }, res);

    expect(res.statusCode).to.equal(503);
    expect(res.body).to.deep.equal({ code: 'CLOSURE_STATUS_RATE_LIMIT_UNAVAILABLE' });
    expect(JSON.stringify(res.body)).not.to.contain('Mongo details');
    expect(receiptCalls).to.equal(0);
  });

  it('rejects invalid capability fields uniformly after limiting', async function() {
    let receiptCalls = 0;
    let limitCalls = 0;
    const controller = createCareClosureReceiptController({
      enabled: true,
      consumeLimits: async () => { limitCalls += 1; },
      receipt: { async inspect() { receiptCalls += 1; } }
    });
    for (const body of [
      { receiptId: 'not-an-id', secret: SECRET },
      { receiptId: OWNER, secret: 'short' },
      { receiptId: OWNER, secret: SECRET, extra: 'forged' },
      {}
    ]) {
      const res = response();
      await controller.inspectClosureReceipt({ body, ip: '203.0.113.9' }, res);
      expect(res.statusCode).to.equal(404);
      expect(res.body).to.deep.equal({ code: 'CLOSURE_RECEIPT_UNAVAILABLE' });
    }
    expect(limitCalls).to.equal(4);
    expect(receiptCalls).to.equal(0);
  });

  it('does not construct dependencies while disabled', async function() {
    let receiptCalls = 0;
    const controller = createCareClosureReceiptController({
      enabled: false,
      receipt: { async inspect() { receiptCalls += 1; } },
      consumeLimits: async () => { throw new Error('must not limit'); }
    });
    const res = response();

    await controller.inspectClosureReceipt({ body: { receiptId: OWNER, secret: SECRET }, ip: '203.0.113.9' }, res);

    expect(res.statusCode).to.equal(503);
    expect(res.body).to.deep.equal({ code: 'CARE_CLOSURE_DISABLED' });
    expect(receiptCalls).to.equal(0);
  });

  it('maps receipt errors to stable status and code without messages', async function() {
    const internal = Object.assign(new Error('owner email and manifest'), {
      status: 404, code: 'CLOSURE_RECEIPT_UNAVAILABLE'
    });
    const controller = createCareClosureReceiptController({
      enabled: true,
      consumeLimits: async () => {},
      receipt: { async inspect() { throw internal; } }
    });
    const res = response();

    await controller.inspectClosureReceipt({ body: { receiptId: OWNER, secret: SECRET }, ip: '203.0.113.9' }, res);

    expect(res.statusCode).to.equal(404);
    expect(res.body).to.deep.equal({ code: 'CLOSURE_RECEIPT_UNAVAILABLE' });
    expect(JSON.stringify(res.body)).not.to.contain('manifest');
  });
});

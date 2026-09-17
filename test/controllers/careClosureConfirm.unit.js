'use strict';

const chai = require('chai');
const {
  createCareClosureConfirmController,
  featureEnabled
} = require('../../api/controllers/careClosureConfirm');

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

describe('care closure confirmation controller', function() {
  it('requires all three confirmation feature flags', function() {
    const previous = {
      collaboration: process.env.CARE_COLLABORATION_ENABLED,
      lifecycle: process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED,
      confirmation: process.env.CARE_CLOSURE_CONFIRMATION_ENABLED
    };
    try {
      for (const collaboration of ['false', 'true']) {
        for (const lifecycle of ['false', 'true']) {
          for (const confirmation of ['false', 'true']) {
            process.env.CARE_COLLABORATION_ENABLED = collaboration;
            process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = lifecycle;
            process.env.CARE_CLOSURE_CONFIRMATION_ENABLED = confirmation;
            expect(featureEnabled()).to.equal(
              collaboration === 'true' && lifecycle === 'true' && confirmation === 'true'
            );
          }
        }
      }
    } finally {
      for (const [key, value] of Object.entries({
        CARE_COLLABORATION_ENABLED: previous.collaboration,
        CARE_LIFECYCLE_TRANSACTIONS_ENABLED: previous.lifecycle,
        CARE_CLOSURE_CONFIRMATION_ENABLED: previous.confirmation
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('limits first, confirms for the authenticated owner, and returns only safe 202 fields', async function() {
    const limits = [];
    const begins = [];
    const controller = createCareClosureConfirmController({
      enabled: true,
      consumeLimits: async input => limits.push(input),
      coordinator: { async begin(owner, familyIds, secret) {
        begins.push({ owner, familyIds, secret });
        return { operationId: 'operation-1', cleanupStatus: 'prepared', accountDeleted: true, owner, familyIds, secret };
      } }
    }).confirmClosure;
    const res = response();

    await controller({ user: { id: OWNER }, body: {
      familyIds: ['family-a', 'family-b'], secret: SECRET, confirmCloudDeletion: true
    }, ip: '198.51.100.3' }, res);

    expect(res.statusCode).to.equal(202);
    expect(res.headers['Cache-Control']).to.equal('no-store');
    expect(res.body).to.deep.equal({ operationId: 'operation-1', cleanupStatus: 'prepared', accountDeleted: false });
    expect(begins).to.deep.equal([{ owner: OWNER, familyIds: ['family-a', 'family-b'], secret: SECRET }]);
    expect(limits).to.deep.equal([{ limiters: undefined, operation: 'closureConfirm', email: OWNER, ip: '198.51.100.3' }]);
  });

  it('rejects anonymous requests before limiting or coordinator access', async function() {
    let limits = 0;
    let begins = 0;
    const controller = createCareClosureConfirmController({
      enabled: true,
      consumeLimits: async () => { limits += 1; },
      coordinator: { async begin() { begins += 1; } }
    }).confirmClosure;
    const res = response();

    await controller({ user: null, body: { familyIds: [], secret: SECRET, confirmCloudDeletion: true }, ip: '127.0.0.1' }, res);

    expect(res.statusCode).to.equal(401);
    expect(res.body).to.deep.equal({ code: 'LOGIN_REQUIRED' });
    expect(limits).to.equal(0);
    expect(begins).to.equal(0);
  });

  it('fails closed while disabled without constructing dependencies', async function() {
    let limits = 0;
    let begins = 0;
    const controller = createCareClosureConfirmController({
      enabled: false,
      consumeLimits: async () => { limits += 1; },
      coordinator: { async begin() { begins += 1; } }
    }).confirmClosure;
    const res = response();

    await controller({ user: { id: OWNER }, body: {}, ip: '127.0.0.1' }, res);

    expect(res.statusCode).to.equal(503);
    expect(res.body).to.deep.equal({ code: 'CARE_CLOSURE_DISABLED' });
    expect(limits).to.equal(0);
    expect(begins).to.equal(0);
  });

  it('requires explicit cloud deletion confirmation', async function() {
    let begins = 0;
    let limits = 0;
    const controller = createCareClosureConfirmController({
      enabled: true,
      consumeLimits: async () => { limits += 1; },
      coordinator: { async begin() { begins += 1; } }
    }).confirmClosure;
    const res = response();

    await controller({ user: { id: OWNER }, body: { familyIds: [], secret: SECRET, confirmCloudDeletion: false }, ip: '127.0.0.1' }, res);

    expect(res.statusCode).to.equal(400);
    expect(res.body).to.deep.equal({ code: 'CLOSURE_CONFIRMATION_REQUIRED' });
    expect(limits).to.equal(1);
    expect(begins).to.equal(0);

    const missing = response();
    await controller({ user: { id: OWNER }, body: { familyIds: [], secret: SECRET }, ip: '127.0.0.1' }, missing);
    expect(missing.statusCode).to.equal(400);
    expect(missing.body).to.deep.equal({ code: 'CLOSURE_CONFIRMATION_REQUIRED' });
    expect(limits).to.equal(2);
  });

  it('rejects malformed, duplicate, prototype and oversized family ids', async function() {
    let begins = 0;
    let limits = 0;
    const controller = createCareClosureConfirmController({
      enabled: true,
      consumeLimits: async () => { limits += 1; },
      coordinator: { async begin() { begins += 1; } }
    }).confirmClosure;
    const invalid = [
      ['family-a', 'family-a'], ['prototype'], ['bad.id'], [''], Array.from({ length: 1001 }, (_, i) => `family-${i}`)
    ];
    for (const familyIds of invalid) {
      const res = response();
      await controller({ user: { id: OWNER }, body: { familyIds, secret: SECRET, confirmCloudDeletion: true }, ip: '127.0.0.1' }, res);
      expect(res.statusCode).to.equal(400);
      expect(res.body).to.deep.equal({ code: 'CLOSURE_CONFIRMATION_INVALID' });
    }
    expect(limits).to.equal(invalid.length);
    expect(begins).to.equal(0);
  });

  it('returns limiter 429 before begin and preserves Retry-After', async function() {
    let begins = 0;
    const limited = Object.assign(new Error('limiter internals'), {
      code: 'CLOSURE_CONFIRM_RATE_LIMITED', status: 429, retryAfter: 31
    });
    const controller = createCareClosureConfirmController({
      enabled: true,
      consumeLimits: async () => { throw limited; },
      coordinator: { async begin() { begins += 1; } }
    }).confirmClosure;
    const res = response();

    await controller({ user: { id: OWNER }, body: { familyIds: [], secret: SECRET, confirmCloudDeletion: true }, ip: '127.0.0.1' }, res);

    expect(res.statusCode).to.equal(429);
    expect(res.headers['Retry-After']).to.equal('31');
    expect(res.body).to.deep.equal({ code: 'CLOSURE_CONFIRM_RATE_LIMITED' });
    expect(begins).to.equal(0);
  });

  it('forwards family revalidation and receipt errors without executing cleanup', async function() {
    for (const failure of [
      Object.assign(new Error('family changed'), { code: 'FAMILY_TRANSFER_REQUIRED', status: 409 }),
      Object.assign(new Error('receipt missing'), { code: 'CLOSURE_RECEIPT_UNAVAILABLE', status: 404 })
    ]) {
      let begins = 0;
      const controller = createCareClosureConfirmController({
        enabled: true,
        consumeLimits: async () => {},
        coordinator: { async begin() { begins += 1; throw failure; } }
      }).confirmClosure;
      const res = response();
      await controller({ user: { id: OWNER }, body: { familyIds: [], secret: SECRET, confirmCloudDeletion: true }, ip: '127.0.0.1' }, res);
      expect(res.statusCode).to.equal(failure.status);
      expect(res.body).to.deep.equal({ code: failure.code });
      expect(begins).to.equal(1);
    }
  });
});

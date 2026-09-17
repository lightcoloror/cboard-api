'use strict';

const chai = require('chai');
const YAML = require('yamljs');
const expect = chai.expect;
const {
  createCareClosureController,
  featureEnabled
} = require('../../api/controllers/careClosure');

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

describe('care closure preview controller', function() {
  it('requires both production feature flags', function() {
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

  it('publishes an authenticated no-input Swagger contract with the preview schema', function() {
    const spec = YAML.load('./api/swagger/swagger.yaml');
    const operation = spec.paths['/care/account/closure-preview'].get;
    expect(operation.security).to.deep.equal([{ Bearer: [] }]);
    expect(operation).not.to.have.property('parameters');
    expect(operation.responses['200'].schema).to.deep.equal({
      $ref: '#/definitions/ClosurePreview'
    });
    expect(spec.definitions.ClosurePreview.required).to.include.members([
      'familyIds', 'families', 'blockers', 'canConfirm', 'confirmationRequired',
      'revalidationRequired', 'deletesCloudData', 'preservesLocalData'
    ]);
  });

  it('returns a no-store preview for the authenticated user only', async function() {
    const calls = [];
    const controller = createCareClosureController({
      enabled: () => true,
      coordinator: { async preview(owner) { calls.push(owner); return { owner, familyIds: [] }; } }
    });
    const res = response();

    await controller({ user: { id: 'user-123' }, query: { owner: 'forged-owner' } }, res);

    expect(res.statusCode).to.equal(200);
    expect(res.headers['Cache-Control']).to.equal('no-store');
    expect(res.body).to.deep.equal({ owner: 'user-123', familyIds: [] });
    expect(calls).to.deep.equal(['user-123']);
  });

  it('fails closed when either feature flag is disabled without constructing or calling a coordinator', async function() {
    let calls = 0;
    const controller = createCareClosureController({
      enabled: () => false,
      coordinator: { async preview() { calls += 1; } }
    });
    const res = response();

    await controller({ user: { id: 'user-123' } }, res);

    expect(res.statusCode).to.equal(503);
    expect(res.body).to.deep.equal({ code: 'CARE_CLOSURE_DISABLED' });
    expect(calls).to.equal(0);
    expect(res.headers['Cache-Control']).to.equal('no-store');
  });

  it('rejects anonymous requests before coordinator access', async function() {
    let calls = 0;
    const controller = createCareClosureController({
      enabled: () => true,
      coordinator: { async preview() { calls += 1; } }
    });
    const res = response();

    await controller({ user: null, query: { owner: 'other-user' } }, res);

    expect(res.statusCode).to.equal(401);
    expect(res.body).to.deep.equal({ code: 'LOGIN_REQUIRED' });
    expect(calls).to.equal(0);
  });

  it('returns stable error code and status without exposing internal details', async function() {
    const internal = Object.assign(new Error('Mongo URI, patient data, and stack details'), {
      status: 409,
      code: 'FAMILY_CLOSE_CONFIRMATION_REQUIRED'
    });
    const controller = createCareClosureController({
      enabled: () => true,
      coordinator: { async preview() { throw internal; } }
    });
    const res = response();

    await controller({ user: { id: 'user-123' } }, res);

    expect(res.statusCode).to.equal(409);
    expect(res.body).to.deep.equal({ code: 'FAMILY_CLOSE_CONFIRMATION_REQUIRED' });
    expect(JSON.stringify(res.body)).not.to.contain('Mongo URI');
  });

  it('uses a generic 503 for unknown coordinator failures', async function() {
    const controller = createCareClosureController({
      enabled: () => true,
      coordinator: { async preview() { throw new Error('private internals'); } }
    });
    const res = response();

    await controller({ user: { id: 'user-123' } }, res);

    expect(res.statusCode).to.equal(503);
    expect(res.body).to.deep.equal({ code: 'CLOSURE_PREVIEW_UNAVAILABLE' });
  });
});

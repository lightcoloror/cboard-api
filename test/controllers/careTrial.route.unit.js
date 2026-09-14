'use strict';

const bodyParser = require('body-parser');
const chai = require('chai');
const express = require('express');
const mockery = require('mockery');
const request = require('supertest');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');
const expect = chai.expect;

describe('care trial Swagger HTTP contract', function() {
  let app; let policy; let limiterError; let claimError; let claims; let limitCalls; let previousNext; let previousTrial;
  before(function(done) {
    previousNext = process.env.CARE_NEXT_ENABLED; previousTrial = process.env.CARE_PUBLIC_TRIAL_ENABLED;
    process.env.CARE_NEXT_ENABLED = 'true'; process.env.CARE_PUBLIC_TRIAL_ENABLED = 'true';
    policy = { version: 'public-v1', trialUnits: 12, weeklyLimit: 4, trialDurationMs: 3000, subscriptionDurationMs: 7000 };
    mockery.enable({ warnOnReplace: false, warnOnUnregistered: false, useCleanCache: true });
    mockery.registerMock('../helpers/careTrialRuntime', { policyFromEnvironment: () => policy, createRuntime: () => ({ claim: async (accountId, familyId) => { claims.push({ accountId, familyId }); if (claimError) throw claimError; return { claimId: 'trial-a', fundingId: 'funding-a', status: 'complete' }; } }) });
    mockery.registerMock('../helpers/careTrialRateLimit', { createCareTrialRateLimitRuntime: () => ({ limiters: { synthetic: true } }), async consumeCareTrialLimits(value) { limitCalls.push(value); if (limiterError) throw limiterError; } });
    app = express(); app.use(bodyParser.json());
    swaggerTools.initializeMiddleware(YAML.load('./api/swagger/swagger.yaml'), middleware => {
      app.use(middleware.swaggerMetadata());
      app.use(middleware.swaggerSecurity({ Bearer: (req, _, token, cb) => {
        if (String(token).includes('synthetic')) { req.user = { id: 'user-a' }; return cb(); }
        const error = new Error('Unauthorized'); error.statusCode = 401; return cb(error);
      } }));
      app.use(middleware.swaggerValidator());
      app.use(middleware.swaggerRouter({ controllers: './test/fixtures/careTrialControllers', useStubs: false }));
      app.use((error, req, res, next) => res.status(error.statusCode || error.status || 400).json({ code: error.code || 'HTTP_CONTRACT_ERROR' }));
      done();
    });
  });
  after(function() { mockery.deregisterAll(); mockery.disable(); if (previousNext === undefined) delete process.env.CARE_NEXT_ENABLED; else process.env.CARE_NEXT_ENABLED = previousNext; if (previousTrial === undefined) delete process.env.CARE_PUBLIC_TRIAL_ENABLED; else process.env.CARE_PUBLIC_TRIAL_ENABLED = previousTrial; });
  beforeEach(function() { policy = { version: 'public-v1', trialUnits: 12, weeklyLimit: 4, trialDurationMs: 3000, subscriptionDurationMs: 7000 }; limiterError = null; claimError = null; claims = []; limitCalls = []; });
  const authorized = () => ({ Authorization: 'Bearer synthetic' });

  it('rejects a request without Bearer before the production handler', async function() {
    await request(app).post('/care/trial-claims').send({ familyId: 'family-a' }).expect(401);
    expect(claims).to.deep.equal([]); expect(limitCalls).to.deep.equal([]);
  });
  it('rejects extra client allocation fields through the Swagger schema', async function() {
    await request(app).post('/care/trial-claims').set(authorized()).send({ familyId: 'family-a', trialUnits: 999 }).expect(400);
    expect(claims).to.deep.equal([]); expect(limitCalls).to.deep.equal([]);
  });
  it('returns 503 for missing policy without calling limiter or claim', async function() {
    policy = null;
    const response = await request(app).post('/care/trial-claims').set(authorized()).send({ familyId: 'family-a' }).expect(503);
    expect(response.body).to.deep.equal({ code: 'TRIAL_NOT_CONFIGURED' }); expect(claims).to.deep.equal([]); expect(limitCalls).to.deep.equal([]);
  });
  it('returns 200 for success and deterministic replay', async function() {
    const first = await request(app).post('/care/trial-claims').set(authorized()).send({ familyId: 'family-a' }).expect(200);
    const replay = await request(app).post('/care/trial-claims').set(authorized()).send({ familyId: 'family-a' }).expect(200);
    expect(replay.body).to.deep.equal(first.body); expect(claims).to.deep.equal([{ accountId: 'user-a', familyId: 'family-a' }, { accountId: 'user-a', familyId: 'family-a' }]);
  });
  it('propagates non-owner denial and limiter retry-after', async function() {
    claimError = Object.assign(new Error('denied'), { status: 403, code: 'FAMILY_OWNER_REQUIRED' });
    expect((await request(app).post('/care/trial-claims').set(authorized()).send({ familyId: 'family-a' }).expect(403)).body.code).to.equal('FAMILY_OWNER_REQUIRED');
    claimError = null; limiterError = Object.assign(new Error('limited'), { status: 429, code: 'CARE_TRIAL_RATE_LIMITED', retryAfter: 60 });
    const limited = await request(app).post('/care/trial-claims').set(authorized()).send({ familyId: 'family-a' }).expect(429);
    expect(limited.headers['retry-after']).to.equal('60'); expect(limited.body.code).to.equal('CARE_TRIAL_RATE_LIMITED');
  });
});

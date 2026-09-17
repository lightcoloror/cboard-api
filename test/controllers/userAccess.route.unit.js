'use strict';

const bodyParser = require('body-parser');
const chai = require('chai');
const express = require('express');
const mockery = require('mockery');
const request = require('supertest');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');
const auth = require('../../api/helpers/auth');

const expect = chai.expect;

describe('user access Swagger routes', function() {
  let app;
  let paginationCalls;
  let findCalls;
  let careChecks;

  before(function(done) {
    paginationCalls = 0;
    findCalls = 0;
    careChecks = 0;
    const user = {
      id: 'user-1',
      toJSON() { return { id: this.id, role: 'user' }; },
      save: async function() { return this; }
    };
    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('../models/User', {
      find(query) {
        paginationCalls += 1;
        return {
          sort() { return this; },
          skip() { return this; },
          limit() { return this; },
          async exec() { return []; }
        };
      },
      count() { return { async exec() { return 0; } }; },
      findById(id) {
        findCalls += 1;
        return { async exec() { return id === 'user-1' ? user : null; } };
      },
      findByIdAndRemove() {
        findCalls += 1;
        return undefined;
      }
    });
    mockery.registerMock('../models/ResetPassword', {});
    mockery.registerMock('../models/Settings', {
      async getOrCreate() { return {}; }
    });
    mockery.registerMock('../models/Subscribers', {});
    mockery.registerMock('../mail', { nev: { options: {} } });
    mockery.registerMock('../helpers/phoneVerificationRuntime', {
      phoneVerificationService: {}
    });
    mockery.registerMock('../helpers/careAccountDeletion', {
      async getCareAccountDeletionBlocker() {
        careChecks += 1;
        return {
          status: 409,
          message: 'Transfer family administration before deleting this account',
          error: { code: 'FAMILY_TRANSFER_REQUIRED' }
        };
      }
    });
    mockery.registerMock('../helpers/localize', {
      async findIpLocation() { return null; },
      isLocalIp() { return true; }
    });
    mockery.registerMock('../helpers/authRequestRateLimit', {
      getAuthRequestLimiters() { return {}; },
      async consumeAuthRequestLimits() {}
    });
    mockery.registerMock('../../config', {
      jwt: { secret: 'synthetic-secret', issuer: 'synthetic-issuer' },
      emailTransport: { from: 'No Reply <noreply@example.test>', host: 'smtp.example.test', auth: { user: 'u', pass: 'p' } }
    });
    mockery.registerMock('../helpers/response', {
      async paginatedResponse() {
        paginationCalls += 1;
        return { total: 0, page: 1, limit: 10, offset: 0, sort: '-_id', search: '', data: [] };
      }
    });

    app = express();
    app.use(bodyParser.json());
    swaggerTools.initializeMiddleware(
      YAML.load('./api/swagger/swagger.yaml'),
      function initialize(middleware) {
        app.use(middleware.swaggerMetadata());
        app.use(middleware.swaggerSecurity({
          Bearer(req, _authOrSecDef, token, cb) {
            const actors = {
              'user-token': { id: 'user-1', role: 'user' },
              'admin-token': { id: 'admin-1', role: 'admin' }
            };
            const actor = actors[String(token).split(' ')[1] || token];
            if (!actor) {
              const error = new Error('Not valid token');
              error.statusCode = 401;
              return cb(error);
            }
            req.user = actor;
            req.auth = { id: actor.id };
            if (!auth.authorizeRequest(req, actor)) {
              const error = new Error('Not authorized');
              error.statusCode = 403;
              return cb(error);
            }
            return cb();
          }
        }));
        app.use(middleware.swaggerValidator());
        app.use(middleware.swaggerRouter({
          controllers: './test/fixtures/userAccessControllers',
          useStubs: false
        }));
        app.use(function handleError(error, req, res, next) {
          if (!error) return next();
          return res.status(error.statusCode || error.status || 400).json({
            message: error.message,
            error: { code: error.statusCode === 401 ? 'USER_ACCESS_UNAUTHORIZED' : 'USER_ACCESS_FORBIDDEN' }
          });
        });
        done();
      }
    );
  });

  after(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  it('returns 401 for anonymous list requests', async function() {
    await request(app).get('/user').expect(401);
    expect(paginationCalls).to.equal(0);
  });

  it('returns 403 for an ordinary list request before pagination and 200 for admin', async function() {
    await request(app).get('/user').set('Authorization', 'Bearer user-token').expect(403);
    expect(paginationCalls).to.equal(0);
    await request(app).get('/user').set('Authorization', 'Bearer admin-token').expect(200);
    expect(paginationCalls).to.equal(1);
  });

  it('allows self get, blocks another user before find, and rejects anonymous get', async function() {
    await request(app).get('/user/user-1').set('Authorization', 'Bearer user-token').expect(200);
    expect(findCalls).to.equal(1);
    await request(app).get('/user/user-2').set('Authorization', 'Bearer user-token').expect(403);
    expect(findCalls).to.equal(1);
    await request(app).get('/user/user-1').expect(401);
  });

  it('blocks ordinary delete before care checks and keeps the admin family blocker', async function() {
    await request(app).delete('/user/user-1').set('Authorization', 'Bearer user-token').expect(403);
    expect(careChecks).to.equal(0);
    await request(app).delete('/user/user-1').set('Authorization', 'Bearer admin-token').expect(409);
    expect(careChecks).to.equal(1);
  });
});

'use strict';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('user password login rate limit', function() {
  let controller;
  let limiterCalls;
  let limiterError;
  let authenticateCalls;
  let sessionCalls;
  let sessionError;

  beforeEach(function() {
    limiterCalls = [];
    limiterError = null;
    authenticateCalls = 0;
    sessionCalls = 0;
    sessionError = null;
    const authenticatedUser = {
      _id: 'user-1',
      email: 'care@example.test',
      authVersion: 0,
      location: { country: 'CN' },
      birthdate: new Date('1990-01-01'),
      toJSON() { return { id: 'user-1', email: this.email, boards: [] }; }
    };
    mockery.enable({ warnOnReplace: false, warnOnUnregistered: false, useCleanCache: true });
    mockery.registerMock('../models/User', {
      authenticate(email, password, callback) {
        authenticateCalls += 1;
        if (!email || !password) return callback(new Error('invalid credentials'));
        callback(null, authenticatedUser);
      }
    });
    mockery.registerMock('../models/ResetPassword', {});
    mockery.registerMock('../models/Settings', {
      async getOrCreate() { return {}; }
    });
    mockery.registerMock('../models/Subscribers', {
      async getByUserId() { return null; }
    });
    mockery.registerMock('../mail', { nev: { options: {} } });
    mockery.registerMock('../helpers/auth', {
      issueToken() { return 'synthetic-token'; }
    });
    mockery.registerMock('../helpers/deviceSessions', {
      async create() { sessionCalls += 1; if (sessionError) throw sessionError; return 'session-1'; }
    });
    mockery.registerMock('../helpers/phoneVerificationRuntime', { phoneVerificationService: {} });
    mockery.registerMock('../helpers/careAccountDeletion', {});
    mockery.registerMock('../helpers/localize', {
      isLocalIp() { return true; },
      async findIpLocation() { return null; }
    });
    mockery.registerMock('../helpers/authRequestRateLimit', {
      getAuthRequestLimiters(operation) {
        return { operation };
      },
      async consumeAuthRequestLimits(input) {
        limiterCalls.push(input);
        if (limiterError) throw limiterError;
      }
    });
    mockery.registerMock('../../config', {
      emailTransport: {
        from: 'No Reply <noreply@example.test>',
        host: 'smtp.example.test',
        auth: { user: 'apikey', pass: 'secret' }
      }
    });
    controller = require('../../api/controllers/user');
  });

  afterEach(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  function response() {
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });
    return {
      statusCode: 0,
      body: null,
      headers: {},
      completed,
      status(code) { this.statusCode = code; return this; },
      set(name, value) { this.headers[name] = value; return this; },
      json(body) { this.body = body; complete(this); return this; }
    };
  }

  function request() {
    return {
      body: { email: ' Care@Example.Test ', password: 'secret' },
      ip: '203.0.113.8',
      session: {},
      get() { return 'synthetic-agent'; }
    };
  }

  it('rejects a limited login before User.authenticate and returns Retry-After', async function() {
    limiterError = Object.assign(new Error('limited'), {
      status: 429,
      code: 'LOGIN_RATE_LIMITED',
      retryAfter: 19
    });
    const res = response();
    await controller.loginUser(request(), res);
    await res.completed;
    expect(res.statusCode).to.equal(429);
    expect(res.headers['Retry-After']).to.equal('19');
    expect(res.body.error.code).to.equal('LOGIN_RATE_LIMITED');
    expect(authenticateCalls).to.equal(0);
  });

  it('fails closed with 503 before authentication when limiter storage is unavailable', async function() {
    limiterError = Object.assign(new Error('backend down'), {
      status: 503,
      code: 'LOGIN_RATE_LIMIT_UNAVAILABLE'
    });
    const res = response();
    await controller.loginUser(request(), res);
    expect(res.statusCode).to.equal(503);
    expect(res.body.error.code).to.equal('LOGIN_RATE_LIMIT_UNAVAILABLE');
    expect(authenticateCalls).to.equal(0);
  });

  it('normalizes the email for limiting and counts the attempt before authentication', async function() {
    const res = response();
    await controller.loginUser(request(), res);
    await res.completed;
    expect(limiterCalls).to.deep.equal([
      {
        limiters: { operation: 'login' },
        operation: 'login',
        email: 'care@example.test',
        ip: '203.0.113.8'
      }
    ]);
    expect(authenticateCalls).to.equal(1);
    expect(res.statusCode).to.equal(200);
    expect(sessionCalls).to.equal(1);
  });

  it('does not create a second session after the next attempt is limited', async function() {
    const first = response();
    await controller.loginUser(request(), first);
    await first.completed;
    limiterError = Object.assign(new Error('limited'), {
      status: 429,
      code: 'LOGIN_RATE_LIMITED',
      retryAfter: 22
    });
    const second = response();
    await controller.loginUser(request(), second);
    await second.completed;
    expect(first.statusCode).to.equal(200);
    expect(second.statusCode).to.equal(429);
    expect(authenticateCalls).to.equal(1);
    expect(sessionCalls).to.equal(1);
  });

  it('treats a missing body as invalid credentials after the limiter', async function() {
    const res = response();
    await controller.loginUser(
      { ip: '203.0.113.8', session: {}, get() { return 'synthetic-agent'; } },
      res
    );
    expect(res.statusCode).to.equal(401);
    expect(authenticateCalls).to.equal(1);
  });

  it('returns account lifecycle errors without establishing a request session', async function() {
    sessionError = Object.assign(new Error('closing'), { status: 409, code: 'ACCOUNT_CLOSING' });
    const req = request();
    const res = response();
    await controller.loginUser(req, res);
    await res.completed;
    expect(res.statusCode).to.equal(409);
    expect(res.body).to.deep.equal({ message: 'Unable to complete login.', error: { code: 'ACCOUNT_CLOSING' } });
    expect(req.session.userId).to.equal(undefined);
  });
});

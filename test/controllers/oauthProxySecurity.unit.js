'use strict';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('OAuth proxy internal authentication', function() {
  let controller;
  let findCalls;

  beforeEach(function() {
    findCalls = 0;
    const user = {
      _id: 'oauth-user-id',
      email: 'oauth@example.test',
      authVersion: 0,
      location: { country: 'CN' },
      toJSON() {
        return { id: this._id, email: this.email, boards: [] };
      }
    };
    const User = {
      findOne() {
        findCalls += 1;
        const chain = {
          populate() {
            return chain;
          },
          async exec() {
            return user;
          }
        };
        return chain;
      }
    };

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('../../config', {
      CBOARD_PROD_URL: 'https://app.example.test',
      CBOARD_QA_URL: 'https://qa.example.test',
      LOCALHOST_PORT_3000_URL: 'http://localhost:3000',
      INTERNAL_API_KEY: 'internal-secret'
    });
    mockery.registerMock('../models/User', User);
    mockery.registerMock('../models/ResetPassword', {});
    mockery.registerMock('../models/Settings', {
      async getOrCreate() {
        return { user: 'oauth-user-id' };
      }
    });
    mockery.registerMock('../models/Subscribers', {
      async getByUserId() {
        return null;
      }
    });
    mockery.registerMock('../mail', { nev: { options: {} } });
    mockery.registerMock('../helpers/auth', {
      issueToken() {
        return 'oauth-token';
      }
    });
    mockery.registerMock('../helpers/phoneVerificationRuntime', {
      phoneVerificationService: {}
    });
    mockery.registerMock('../helpers/localize', {
      async findIpLocation() {
        return null;
      },
      isLocalIp() {
        return true;
      }
    });
    controller = require('../../api/controllers/user');
  });

  afterEach(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  function request(authorization) {
    return {
      body: {
        accessToken: 'provider-token',
        refreshToken: 'provider-refresh',
        profile: { id: 'provider-user' }
      },
      swagger: { params: { provider: { value: 'google' } } },
      get(name) {
        return name === 'Authorization' ? authorization : undefined;
      }
    };
  }

  function response() {
    return {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      }
    };
  }

  it('rejects missing and invalid internal bearer keys before user lookup', async function() {
    for (const authorization of [
      undefined,
      '',
      'Basic value',
      'Bearer wrong'
    ]) {
      const res = response();
      await controller.proxyOauth(request(authorization), res);
      expect(res.statusCode).to.equal(401);
      expect(res.body).to.deep.equal({
        message: 'Not authorized to use the OAuth proxy endpoint.'
      });
    }
    expect(findCalls).to.equal(0);
  });

  it('allows the configured internal bearer key to reach the existing OAuth flow', async function() {
    const res = response();

    await controller.proxyOauth(request('Bearer internal-secret'), res);

    expect(findCalls).to.equal(1);
    expect(res.statusCode).to.equal(200);
    expect(res.body).to.include({
      id: 'oauth-user-id',
      email: 'oauth@example.test',
      authToken: 'oauth-token'
    });
  });
});

'use strict';

const { expect } = require('chai');
const mockery = require('mockery');

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

describe('subscription catalog synchronization controller', function() {
  let controller;
  let events;

  beforeEach(function() {
    events = [];
    const Subscription = {};

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('../models/Subscription', Subscription);
    mockery.registerMock('../helpers/auth', {
      async gapiAuth() {
        events.push('auth');
      }
    });
    mockery.registerMock('../helpers/response', {
      async paginatedResponse(model, options, requestQuery) {
        events.push('response');
        expect(model).to.equal(Subscription);
        expect(options).to.deep.equal({ query: {} });
        expect(requestQuery).to.deep.equal({});
        return { total: 0, data: [] };
      }
    });
    mockery.registerMock('../helpers/query', {
      getORQuery() {
        throw new Error('search query should not be used in this test');
      }
    });
    mockery.registerMock(
      '../helpers/paypal',
      class {
        async listPlans() {
          events.push('paypal');
          return { plans: [] };
        }
      }
    );
    mockery.registerMock('../helpers/googlePlaySubscriptionCatalog', {
      async listAllGooglePlaySubscriptions({ client, packageName }) {
        events.push('google');
        expect(client).to.equal(playConsole);
        expect(packageName).to.equal('com.unicef.cboard');
        return [];
      }
    });
    mockery.registerMock('../helpers/subscriptionCatalogReconciliation', {
      async reconcileStaleLocalSubscriptions(input) {
        events.push('reconcile');
        expect(input).to.deep.equal({
          Subscription,
          remoteSubscriptions: []
        });
        return {
          deleted: [],
          localCount: 0,
          remoteCount: 0,
          retainedCount: 0
        };
      }
    });

    const playConsole = {
      monetization: {
        subscriptions: {}
      }
    };
    mockery.registerMock('googleapis', {
      google: {
        androidpublisher(version) {
          expect(version).to.equal('v3');
          return playConsole;
        }
      }
    });

    controller = require('../../api/controllers/subscription');
  });

  afterEach(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  it('reconciles the complete catalog before building the response page', async function() {
    const response = createResponse();

    await controller.syncSubscriptions({ query: {} }, response);

    expect(response.statusCode).to.equal(200);
    expect(response.body).to.deep.equal({ total: 0, data: [] });
    expect(events).to.deep.equal([
      'auth',
      'paypal',
      'google',
      'reconcile',
      'response'
    ]);
  });
});

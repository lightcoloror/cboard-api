'use strict';

const { expect } = require('chai');
const mockery = require('mockery');

describe('subscriber controller security boundaries', function() {
  const subscriberId = '507f1f77bcf86cd799439011';
  let controller;
  let actor;
  let existing;
  let constructed;
  let saveCount;
  let paypalDetailsCount;
  let paypalCancelCount;
  let catalogLookupCount;
  let deleteCount;
  let duplicateTransaction;

  const catalog = {
    subscriptionId: 'premium',
    name: 'Family communication',
    status: 'active',
    plans: [{
      planId: 'yearly',
      paypalId: 'P-YEARLY',
      status: 'active',
      period: 'P1Y',
      tags: ['family'],
      countries: [{
        regionCode: 'CN',
        price: { currencyCode: 'CNY', units: 88 }
      }]
    }]
  };

  function makeSubscriber(overrides = {}) {
    return {
      _id: subscriberId,
      userId: 'user-1',
      country: 'CN',
      status: 'not_subscribed',
      product: {
        subscriptionId: 'premium',
        planId: 'yearly',
        paypalId: 'P-YEARLY',
        title: 'Family communication',
        billingPeriod: 'P1Y',
        price: { currencyCode: 'CNY', units: 88 }
      },
      transaction: null,
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
      async save() {
        saveCount += 1;
        return this;
      },
      ...overrides
    };
  }

  beforeEach(function() {
    actor = { requestedBy: 'user-1', isAdmin: false };
    existing = makeSubscriber();
    constructed = null;
    saveCount = 0;
    paypalDetailsCount = 0;
    paypalCancelCount = 0;
    catalogLookupCount = 0;
    deleteCount = 0;
    duplicateTransaction = null;

    class Subscriber {
      constructor(value) {
        Object.assign(this, makeSubscriber({
          ...value,
          _id: subscriberId,
          transaction: value.transaction || null
        }));
        constructed = this;
      }

      static async findOne(query) {
        if (query._id) return existing;
        if (query['transaction.subscriptionId']) return existing;
        if (query['transaction.transactionId']) return duplicateTransaction;
        if (query['transaction.originalTransactionId']) return null;
        return null;
      }

      static findByIdAndRemove(id, callback) {
        deleteCount += 1;
        callback(null, existing);
      }
    }

    const paypal = {
      async getSubscriptionDetails() {
        paypalDetailsCount += 1;
        return {
          id: 'I-SUBSCRIPTION',
          custom_id: 'user-1',
          plan_id: 'P-YEARLY',
          status: 'ACTIVE',
          start_time: '2026-07-22T00:00:00Z',
          billing_info: {
            next_billing_time: '2027-07-22T00:00:00Z'
          },
          payer: { email_address: 'private@example.test' }
        };
      },
      async cancelPlan() {
        paypalCancelCount += 1;
      }
    };

    const Subscription = {
      findOne() {
        catalogLookupCount += 1;
        return { async exec() { return catalog; } };
      }
    };

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('../models/Subscribers', Subscriber);
    mockery.registerMock('../models/Subscription', Subscription);
    mockery.registerMock('../helpers/auth', {
      async gapiAuth() {},
      getAuthDataFromReq() {
        return actor;
      }
    });
    mockery.registerMock('../helpers/paypal', function Paypal() {
      return paypal;
    });
    mockery.registerMock('../helpers/appStore', {
      async verifyAppStorePurchase() {
        throw new Error('not used');
      },
      setSubscriptionState() {
        return 'expired';
      }
    });
    controller = require('../../api/controllers/subscriber');
  });

  afterEach(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  function response() {
    return {
      statusCode: 0,
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

  function request(body = {}, id = subscriberId) {
    return {
      body,
      swagger: { params: { id: { value: id } } },
      user: { id: actor.requestedBy, isAdmin: actor.isAdmin }
    };
  }

  it('does not let a user create a subscriber for another account', async function() {
    const res = response();
    await controller.createSubscriber(
      request({ userId: 'victim', country: 'CN' }),
      res
    );

    expect(res.statusCode).to.equal(403);
    expect(constructed).to.equal(null);
  });

  it('forces a user-created subscriber to start without client transaction state', async function() {
    const res = response();
    await controller.createSubscriber(request({
      userId: 'user-1',
      country: 'CN',
      status: 'active',
      transaction: { purchaseToken: 'forged' },
      product: existing.product
    }), res);

    expect(res.statusCode).to.equal(200);
    expect(constructed.status).to.equal('not_subscribed');
    expect(constructed.transaction).to.equal(null);
    expect(JSON.stringify(res.body)).not.to.contain('forged');
  });

  it('rejects protected fields on an owner update', async function() {
    const res = response();
    await controller.updateSubscriber(
      request({ status: 'active', transaction: { state: 'approved' } }),
      res
    );

    expect(res.statusCode).to.equal(400);
    expect(existing.status).to.equal('not_subscribed');
    expect(saveCount).to.equal(0);
  });

  it('allows a canceled subscriber to select a plan after its expiry', async function() {
    existing.status = 'canceled';
    existing.transaction = {
      expiryDate: '2020-01-01T00:00:00.000Z'
    };
    const res = response();

    await controller.updateSubscriber(
      request({ product: existing.product }),
      res
    );

    expect(res.statusCode).to.equal(200);
    expect(saveCount).to.equal(1);
  });

  it('checks transaction ownership before catalog or provider calls', async function() {
    actor = { requestedBy: 'attacker', isAdmin: false };
    const res = response();
    await controller.createTransaction(
      request({
        platform: 'paypal',
        subscriptionId: 'I-SUBSCRIPTION'
      }),
      res
    );

    expect(res.statusCode).to.equal(403);
    expect(catalogLookupCount).to.equal(0);
    expect(paypalDetailsCount).to.equal(0);
  });

  it('accepts only a PayPal owner and plan verified by the server catalog', async function() {
    const res = response();
    await controller.createTransaction(
      request({
        platform: 'paypal',
        subscriptionId: 'I-SUBSCRIPTION',
        facilitatorAccessToken: 'client-secret'
      }),
      res
    );

    expect(res.statusCode).to.equal(200);
    expect(res.body.ok).to.equal(true);
    expect(existing.status).to.equal('active');
    expect(existing.product.title).to.equal('Family communication');
    expect(existing.transaction.nativePurchase.custom_id).to.equal('user-1');
    expect(JSON.stringify(existing.transaction)).not.to.contain('private');
    expect(JSON.stringify(res.body)).not.to.contain('client-secret');
  });

  it('rejects a provider transaction already assigned to another subscriber', async function() {
    duplicateTransaction = { _id: '507f191e810c19729de860ea' };
    const res = response();

    await controller.createTransaction(
      request({
        platform: 'paypal',
        subscriptionId: 'I-SUBSCRIPTION'
      }),
      res
    );

    expect(res.statusCode).to.equal(200);
    expect(res.body.ok).to.equal(false);
    expect(res.body.error.message).to.equal('Transaction ID already exists.');
    expect(saveCount).to.equal(0);
  });

  it('does not cancel another account PayPal subscription', async function() {
    actor = { requestedBy: 'attacker', isAdmin: false };
    existing.transaction = {
      platform: 'paypal',
      subscriptionId: 'I-SUBSCRIPTION'
    };
    const res = response();
    await controller.cancelPlan(request({}, 'I-SUBSCRIPTION'), res);

    expect(res.statusCode).to.equal(403);
    expect(paypalCancelCount).to.equal(0);
  });

  it('does not rely only on Swagger scopes for subscriber deletion', function() {
    const res = response();

    controller.deleteSubscriber(request(), res);

    expect(res.statusCode).to.equal(403);
    expect(deleteCount).to.equal(0);
  });
});

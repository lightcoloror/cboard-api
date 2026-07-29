'use strict';

const { expect } = require('chai');
const {
  MAX_ANDROID_PURCHASE_TOKEN_LENGTH,
  MAX_ANDROID_RECEIPT_LENGTH,
  buildAndroidPurchaseTransaction,
  buildVerifiedPaypalTransaction,
  isSubscriberActive,
  normalizeSelectedProduct,
  resolveCatalogProduct,
  sanitizeSubscriber
} = require('../../api/helpers/subscriptionSecurity');

describe('subscription security helper', function() {
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
  const Subscription = {
    findOne(query) {
      return {
        async exec() {
          return query.subscriptionId === catalog.subscriptionId
            ? catalog
            : null;
        }
      };
    }
  };

  it('keeps only bounded product selection fields', function() {
    const product = normalizeSelectedProduct({
      subscriptionId: 'premium',
      id: 'yearly',
      paypalId: 'P-YEARLY',
      title: 'Family communication',
      billingPeriod: 'P1Y',
      price: { currencyCode: 'CNY', units: 88, secret: 'no' },
      tag: 'family',
      status: 'active',
      transaction: { purchaseToken: 'no' }
    });

    expect(product).to.deep.equal({
      subscriptionId: 'premium',
      planId: 'yearly',
      paypalId: 'P-YEARLY',
      title: 'Family communication',
      billingPeriod: 'P1Y',
      price: { currencyCode: 'CNY', units: 88 },
      tag: 'family'
    });
  });

  it('normalizes an Android transaction without retaining its receipt envelope', function() {
    const transaction = buildAndroidPurchaseTransaction({
      catalogProduct: {
        subscriptionId: 'premium',
        planId: 'yearly',
        title: 'Family communication',
        billingPeriod: 'P1Y',
        price: '88'
      },
      body: {
        platform: 'android-playstore',
        nativePurchase: {
          receipt: JSON.stringify({
            orderId: 'GPA.1',
            packageName: 'com.unicef.cboard',
            productId: 'premium',
            purchaseToken: 'purchase-token',
            autoRenewing: true
          })
        }
      }
    });

    expect(transaction.transactionId).to.equal('GPA.1');
    expect(transaction.nativePurchase.productId).to.equal('premium');
    expect(transaction.nativePurchase.purchaseToken).to.equal('purchase-token');
    expect(transaction.nativePurchase).not.to.have.property('receipt');
  });

  it('rejects oversized Android receipt and purchase token inputs', function() {
    const catalogProduct = {
      subscriptionId: 'premium',
      planId: 'yearly',
      title: 'Family communication',
      billingPeriod: 'P1Y',
      price: '88'
    };
    expect(() => buildAndroidPurchaseTransaction({
      catalogProduct,
      body: {
        nativePurchase: {
          receipt: 'x'.repeat(MAX_ANDROID_RECEIPT_LENGTH + 1)
        }
      }
    })).to.throw('receipt');
    expect(() => buildAndroidPurchaseTransaction({
      catalogProduct,
      body: {
        nativePurchase: {
          orderId: 'GPA.1',
          productId: 'premium',
          purchaseToken:
            'x'.repeat(MAX_ANDROID_PURCHASE_TOKEN_LENGTH + 1)
        }
      }
    })).to.throw('selected product');
  });

  it('resolves price and provider ids from the server catalog', async function() {
    const product = await resolveCatalogProduct({
      Subscription,
      country: 'cn',
      selectedProduct: {
        subscriptionId: 'premium',
        planId: 'yearly',
        paypalId: 'P-YEARLY',
        title: 'client controlled',
        price: '0'
      }
    });

    expect(product).to.deep.equal({
      subscriptionId: 'premium',
      planId: 'yearly',
      paypalId: 'P-YEARLY',
      title: 'Family communication',
      billingPeriod: 'P1Y',
      price: { currencyCode: 'CNY', units: 88 },
      tag: 'family'
    });
  });

  it('fails closed when a client substitutes a plan outside the catalog', async function() {
    let error;
    try {
      await resolveCatalogProduct({
        Subscription,
        country: 'CN',
        selectedProduct: {
          subscriptionId: 'premium',
          planId: 'attacker-plan',
          paypalId: 'P-ATTACKER'
        }
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    expect(error.message).to.contain('catalog');
  });

  it('binds PayPal owner and plan while dropping payer details', function() {
    const transaction = buildVerifiedPaypalTransaction({
      subscriber: {
        userId: 'user-1',
        product: {
          subscriptionId: 'premium',
          planId: 'yearly',
          paypalId: 'P-YEARLY'
        }
      },
      remoteData: {
        id: 'I-SUBSCRIPTION',
        custom_id: 'user-1',
        plan_id: 'P-YEARLY',
        status: 'ACTIVE',
        start_time: '2026-07-22T00:00:00Z',
        billing_info: { next_billing_time: '2027-07-22T00:00:00Z' },
        payer: { email_address: 'private@example.test' },
        facilitatorAccessToken: 'server-must-not-store-this'
      }
    });

    expect(transaction.subscriptionState).to.equal('active');
    expect(transaction.nativePurchase.custom_id).to.equal('user-1');
    expect(JSON.stringify(transaction)).not.to.contain('private@example.test');
    expect(JSON.stringify(transaction)).not.to.contain('facilitatorAccessToken');
  });

  it('rejects a PayPal subscription without the matching CBoard owner', function() {
    expect(() => buildVerifiedPaypalTransaction({
      subscriber: {
        userId: 'user-1',
        product: {
          subscriptionId: 'premium',
          planId: 'yearly',
          paypalId: 'P-YEARLY'
        }
      },
      remoteData: {
        id: 'I-SUBSCRIPTION',
        plan_id: 'P-YEARLY',
        status: 'ACTIVE'
      }
    })).to.throw('owner');
  });

  it('never returns purchase tokens, receipts or provider access tokens', function() {
    const response = sanitizeSubscriber({
      _id: 'subscriber-1',
      userId: 'user-1',
      country: 'CN',
      status: 'active',
      product: {
        subscriptionId: 'premium',
        planId: 'yearly',
        paypalId: 'P-YEARLY',
        title: 'Family communication',
        billingPeriod: 'P1Y',
        price: { currencyCode: 'CNY', units: 88 }
      },
      transaction: {
        platform: 'android-playstore',
        transactionId: 'GPA.1',
        facilitatorAccessToken: 'secret-access',
        nativePurchase: {
          productId: 'premium',
          purchaseToken: 'secret-purchase-token',
          receipt: 'secret-receipt',
          signature: 'secret-signature'
        }
      }
    });

    const serialized = JSON.stringify(response);
    expect(serialized).not.to.contain('secret-access');
    expect(serialized).not.to.contain('secret-purchase-token');
    expect(serialized).not.to.contain('secret-receipt');
    expect(serialized).not.to.contain('secret-signature');
    expect(response.transaction.nativePurchase.productId).to.equal('premium');
  });

  it('treats grace-period and canceled access as active only until expiry', function() {
    expect(isSubscriberActive('active')).to.equal(true);
    expect(isSubscriberActive('in_grace_period')).to.equal(true);
    expect(isSubscriberActive({
      status: 'canceled',
      transaction: { expiryDate: '2026-08-01T00:00:00.000Z' }
    }, new Date('2026-07-22T00:00:00.000Z'))).to.equal(true);
    expect(isSubscriberActive({
      status: 'canceled',
      transaction: { expiryDate: '2026-07-01T00:00:00.000Z' }
    }, new Date('2026-07-22T00:00:00.000Z'))).to.equal(false);
    expect(isSubscriberActive('canceled')).to.equal(true);
    expect(isSubscriberActive('expired')).to.equal(false);
  });
});

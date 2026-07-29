'use strict';

const path = require('path');
const { expect } = require('chai');
const YAML = require('yamljs');

describe('subscription Swagger security contract', function() {
  const swagger = YAML.load(path.resolve(
    __dirname,
    '../../api/swagger/swagger.yaml'
  ));

  it('does not require a client-controlled owner or subscription status', function() {
    const subscriber = swagger.definitions.Subscriber;

    expect(subscriber.required).to.deep.equal(['country']);
    expect(subscriber.properties).to.have.property('userId');
    expect(subscriber.properties).not.to.have.property('userID');
    expect(subscriber.properties.product.$ref)
      .to.equal('#/definitions/SubscriberProduct');
  });

  it('documents only a bounded transaction response', function() {
    const transaction = swagger.definitions.SafeSubscriptionTransaction;
    const nativePurchase = swagger.definitions.SafeSubscriptionNativePurchase;

    expect(transaction.properties.nativePurchase.$ref)
      .to.equal('#/definitions/SafeSubscriptionNativePurchase');
    expect(nativePurchase.properties).not.to.have.property('purchaseToken');
    expect(nativePurchase.properties).not.to.have.property('receipt');
    expect(nativePurchase.properties).not.to.have.property('signature');
    expect(nativePurchase.properties).not.to.have.property('payer');
  });

  it('documents bounded Android transaction input', function() {
    const operation =
      swagger.paths['/subscriber/{id}/transaction'].post;
    const bodyParameter = operation.parameters.find(
      parameter => parameter.in === 'body'
    );
    const android =
      swagger.definitions.SubscriptionAndroidPurchaseRequest;

    expect(bodyParameter.schema.$ref)
      .to.equal('#/definitions/SubscriptionTransactionRequest');
    expect(swagger.paths['/analytics/userActivity/{id}'].post.parameters)
      .not.to.deep.include({
        name: 'transaction',
        in: 'body',
        required: true,
        schema: { $ref: '#/definitions/SubscriptionTransactionRequest' }
      });
    expect(swagger.paths['/board/{id}'].get.parameters)
      .not.to.deep.include({
        name: 'transaction',
        in: 'body',
        required: true,
        schema: { $ref: '#/definitions/SubscriptionTransactionRequest' }
      });
    expect(android.properties.receipt.maxLength).to.equal(65536);
    expect(android.properties.purchaseToken.maxLength).to.equal(4096);
  });

  it('keeps bulk provider synchronization admin-only', function() {
    const synchronize = swagger.paths['/subscription/synchronize'].get;

    expect(synchronize['x-security-scopes']).to.deep.equal(['admin']);
  });
});

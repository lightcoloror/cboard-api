'use strict';

const { expect } = require('chai');
const {
  reconcileStaleLocalSubscriptions
} = require('../../api/helpers/subscriptionCatalogReconciliation');

function createSubscriptionModel(localSubscriptions) {
  const deletedIds = [];
  return {
    deletedIds,
    model: {
      find(query) {
        expect(query).to.deep.equal({});
        return {
          async exec() {
            return localSubscriptions;
          }
        };
      },
      async findOneAndDelete(query) {
        deletedIds.push(query.subscriptionId);
        return localSubscriptions.find(
          subscription => subscription.subscriptionId === query.subscriptionId
        );
      }
    }
  };
}

describe('subscription catalog reconciliation helper', function() {
  it('checks the complete local catalog instead of a ten-item response page', async function() {
    const localSubscriptions = Array.from({ length: 12 }, (_, index) => ({
      subscriptionId: `local-${index + 1}`,
      name: `Local ${index + 1}`
    }));
    const harness = createSubscriptionModel(localSubscriptions);
    const remoteSubscriptions = localSubscriptions
      .filter(subscription => subscription.subscriptionId !== 'local-11')
      .map(subscription => ({
        productId: subscription.subscriptionId
      }));

    const result = await reconcileStaleLocalSubscriptions({
      Subscription: harness.model,
      remoteSubscriptions
    });

    expect(harness.deletedIds).to.deep.equal(['local-11']);
    expect(result.localCount).to.equal(12);
    expect(result.remoteCount).to.equal(11);
    expect(result.retainedCount).to.equal(11);
  });

  it('validates every remote id before reading or deleting local data', async function() {
    let findCount = 0;
    let deleteCount = 0;
    const Subscription = {
      find() {
        findCount += 1;
        return {
          async exec() {
            return [];
          }
        };
      },
      async findOneAndDelete() {
        deleteCount += 1;
      }
    };

    let error;
    try {
      await reconcileStaleLocalSubscriptions({
        Subscription,
        remoteSubscriptions: [{ productId: 'valid' }, { productId: '' }]
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect(error.message).to.equal('Remote subscription id is invalid.');
    expect(findCount).to.equal(0);
    expect(deleteCount).to.equal(0);
  });

  it('validates the full local catalog before the first deletion', async function() {
    let deleteCount = 0;
    const Subscription = {
      find() {
        return {
          async exec() {
            return [
              { subscriptionId: 'stale', name: 'Stale' },
              { subscriptionId: '', name: 'Broken' }
            ];
          }
        };
      },
      async findOneAndDelete() {
        deleteCount += 1;
      }
    };

    let error;
    try {
      await reconcileStaleLocalSubscriptions({
        Subscription,
        remoteSubscriptions: []
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect(error.message).to.equal('Local subscription id is invalid.');
    expect(deleteCount).to.equal(0);
  });
});

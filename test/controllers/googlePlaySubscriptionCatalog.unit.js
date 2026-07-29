'use strict';

const { expect } = require('chai');
const {
  GOOGLE_PLAY_SUBSCRIPTION_PAGE_SIZE,
  MAX_GOOGLE_PLAY_SUBSCRIPTION_PAGES,
  MAX_GOOGLE_PLAY_PAGE_TOKEN_LENGTH,
  listAllGooglePlaySubscriptions
} = require('../../api/helpers/googlePlaySubscriptionCatalog');

function createClient(responses) {
  const requests = [];
  return {
    requests,
    client: {
      monetization: {
        subscriptions: {
          async list(params) {
            requests.push(params);
            const response = responses.shift();
            if (response instanceof Error) throw response;
            return { data: response || {} };
          }
        }
      }
    }
  };
}

describe('Google Play subscription catalog helper', function() {
  it('collects all pages while preserving the official page token', async function() {
    const harness = createClient([
      {
        subscriptions: [{ productId: 'first' }],
        nextPageToken: 'opaque-token'
      },
      {
        subscriptions: [{ productId: 'second' }]
      }
    ]);

    const result = await listAllGooglePlaySubscriptions({
      client: harness.client,
      packageName: 'com.unicef.cboard'
    });

    expect(result.map(item => item.productId)).to.deep.equal([
      'first',
      'second'
    ]);
    expect(harness.requests).to.deep.equal([
      {
        packageName: 'com.unicef.cboard',
        pageSize: GOOGLE_PLAY_SUBSCRIPTION_PAGE_SIZE
      },
      {
        packageName: 'com.unicef.cboard',
        pageSize: GOOGLE_PLAY_SUBSCRIPTION_PAGE_SIZE,
        pageToken: 'opaque-token'
      }
    ]);
  });

  it('fails closed when Google repeats a next page token', async function() {
    const harness = createClient([
      { subscriptions: [], nextPageToken: 'repeated' },
      { subscriptions: [], nextPageToken: 'repeated' }
    ]);

    let error;
    try {
      await listAllGooglePlaySubscriptions({
        client: harness.client,
        packageName: 'com.unicef.cboard'
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect(error.message).to.equal(
      'Google Play subscription pagination repeated a token.'
    );
    expect(harness.requests).to.have.length(2);
  });

  it('rejects malformed pages and oversized opaque tokens', async function() {
    const malformed = createClient([{ subscriptions: {} }]);
    const oversized = createClient([
      {
        subscriptions: [],
        nextPageToken: 'x'.repeat(MAX_GOOGLE_PLAY_PAGE_TOKEN_LENGTH + 1)
      }
    ]);

    let malformedError;
    let oversizedError;
    try {
      await listAllGooglePlaySubscriptions({
        client: malformed.client,
        packageName: 'com.unicef.cboard'
      });
    } catch (caught) {
      malformedError = caught;
    }
    try {
      await listAllGooglePlaySubscriptions({
        client: oversized.client,
        packageName: 'com.unicef.cboard'
      });
    } catch (caught) {
      oversizedError = caught;
    }

    expect(malformedError.message).to.equal(
      'Google Play subscription list response is invalid.'
    );
    expect(oversizedError.message).to.equal(
      'Google Play subscription page token is invalid.'
    );
  });

  it('stops before an unbounded provider pagination loop', async function() {
    let requestCount = 0;
    const client = {
      monetization: {
        subscriptions: {
          async list() {
            requestCount += 1;
            return {
              data: {
                subscriptions: [],
                nextPageToken: `page-${requestCount}`
              }
            };
          }
        }
      }
    };

    let error;
    try {
      await listAllGooglePlaySubscriptions({
        client,
        packageName: 'com.unicef.cboard'
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect(error.message).to.equal(
      'Google Play subscription catalog exceeds pagination limit.'
    );
    expect(requestCount).to.equal(MAX_GOOGLE_PLAY_SUBSCRIPTION_PAGES);
  });
});

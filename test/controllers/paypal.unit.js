'use strict';

const { expect } = require('chai');
const nock = require('nock');

process.env.PAYPAL_API_CLIENT_ID = 'test-client';
process.env.PAYPAL_API_CLIENT_SECRET = 'test-secret';

const Paypal = require('../../api/helpers/paypal');

const PAYPAL_ORIGIN = 'https://api-m.sandbox.paypal.com';
const ORIGINAL_NO_PROXY = process.env.NO_PROXY;
const ORIGINAL_LOWERCASE_NO_PROXY = process.env.no_proxy;

function mockAccessToken(response = { access_token: 'access-token' }) {
  return nock(PAYPAL_ORIGIN)
    .post('/v1/oauth2/token', 'grant_type=client_credentials')
    .basicAuth({
      user: 'test-client',
      pass: 'test-secret'
    })
    .reply(200, response);
}

describe('PayPal API helper', function() {
  beforeEach(function() {
    process.env.PAYPAL_API_CLIENT_ID = 'test-client';
    process.env.PAYPAL_API_CLIENT_SECRET = 'test-secret';
    process.env.NO_PROXY = 'api-m.sandbox.paypal.com';
    process.env.no_proxy = 'api-m.sandbox.paypal.com';
    nock.disableNetConnect();
  });

  afterEach(function() {
    nock.cleanAll();
    nock.enableNetConnect();
    if (ORIGINAL_NO_PROXY === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = ORIGINAL_NO_PROXY;
    if (ORIGINAL_LOWERCASE_NO_PROXY === undefined) {
      delete process.env.no_proxy;
    } else {
      process.env.no_proxy = ORIGINAL_LOWERCASE_NO_PROXY;
    }
  });

  it('lists plans with the documented query in the Axios request config', async function() {
    const token = mockAccessToken();
    const plans = nock(PAYPAL_ORIGIN)
      .get('/v1/billing/plans')
      .query({
        page_size: '20',
        page: '1',
        total_required: 'true'
      })
      .matchHeader('Authorization', 'Bearer access-token')
      .reply(200, {
        plans: [{ id: 'P-YEARLY', status: 'ACTIVE' }],
        total_items: 1,
        total_pages: 1
      });

    const result = await new Paypal().listPlans();

    expect(result.plans).to.have.length(1);
    expect(result.total_items).to.equal(1);
    expect(token.isDone()).to.equal(true);
    expect(plans.isDone()).to.equal(true);
  });

  it('collects every documented PayPal plan page with one access token', async function() {
    const token = mockAccessToken();
    const firstPage = nock(PAYPAL_ORIGIN)
      .get('/v1/billing/plans')
      .query({
        page_size: '20',
        page: '1',
        total_required: 'true'
      })
      .matchHeader('Authorization', 'Bearer access-token')
      .reply(200, {
        plans: Array.from({ length: 20 }, (_, index) => ({
          id: `P-FIRST-${index + 1}`
        })),
        total_items: 21,
        total_pages: 2
      });
    const secondPage = nock(PAYPAL_ORIGIN)
      .get('/v1/billing/plans')
      .query({
        page_size: '20',
        page: '2',
        total_required: 'true'
      })
      .matchHeader('Authorization', 'Bearer access-token')
      .reply(200, {
        plans: [{ id: 'P-SECOND-1' }],
        total_items: 21,
        total_pages: 2
      });

    const result = await new Paypal().listPlans();

    expect(result.plans).to.have.length(21);
    expect(result.plans[20].id).to.equal('P-SECOND-1');
    expect(result.total_items).to.equal(21);
    expect(result.total_pages).to.equal(2);
    expect(token.isDone()).to.equal(true);
    expect(firstPage.isDone()).to.equal(true);
    expect(secondPage.isDone()).to.equal(true);
  });

  it('stops on a short page when PayPal omits total_pages', async function() {
    mockAccessToken();
    nock(PAYPAL_ORIGIN)
      .get('/v1/billing/plans')
      .query({
        page_size: '20',
        page: '1',
        total_required: 'true'
      })
      .reply(200, {
        plans: Array.from({ length: 20 }, (_, index) => ({
          id: `P-FULL-${index + 1}`
        }))
      });
    const lastPage = nock(PAYPAL_ORIGIN)
      .get('/v1/billing/plans')
      .query({
        page_size: '20',
        page: '2',
        total_required: 'true'
      })
      .reply(200, {
        plans: [{ id: 'P-LAST' }]
      });

    const result = await new Paypal().listPlans();

    expect(result.plans).to.have.length(21);
    expect(result.total_items).to.equal(21);
    expect(result.total_pages).to.equal(2);
    expect(lastPage.isDone()).to.equal(true);
  });

  it('fails closed before requesting a catalog above the bounded page limit', async function() {
    mockAccessToken();
    const firstPage = nock(PAYPAL_ORIGIN)
      .get('/v1/billing/plans')
      .query({
        page_size: '20',
        page: '1',
        total_required: 'true'
      })
      .reply(200, {
        plans: [{ id: 'P-FIRST' }],
        total_items: 2020,
        total_pages: 101
      });

    let error;
    try {
      await new Paypal().listPlans();
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect(error.message).to.equal(
      'PayPal plan catalog exceeds pagination limit.'
    );
    expect(firstPage.isDone()).to.equal(true);
    expect(nock.pendingMocks()).to.deep.equal([]);
  });

  it('sends the cancellation reason as the documented top-level body', async function() {
    const token = mockAccessToken();
    const cancellation = nock(PAYPAL_ORIGIN)
      .post('/v1/billing/subscriptions/I-SUBSCRIPTION/cancel', {
        reason: 'User cancelled'
      })
      .matchHeader('Authorization', 'Bearer access-token')
      .reply(204);

    const result = await new Paypal().cancelPlan('I-SUBSCRIPTION');

    expect(result).to.equal('');
    expect(token.isDone()).to.equal(true);
    expect(cancellation.isDone()).to.equal(true);
  });

  it('encodes a bounded subscription id before requesting details', async function() {
    mockAccessToken();
    const details = nock(PAYPAL_ORIGIN)
      .get('/v1/billing/subscriptions/I-SUBSCRIPTION%20ONE')
      .matchHeader('Authorization', 'Bearer access-token')
      .reply(200, {
        id: 'I-SUBSCRIPTION ONE',
        status: 'ACTIVE'
      });

    const result = await new Paypal().getSubscriptionDetails(
      'I-SUBSCRIPTION ONE'
    );

    expect(result.status).to.equal('ACTIVE');
    expect(details.isDone()).to.equal(true);
  });

  it('fails before a provider request when credentials are missing', async function() {
    delete process.env.PAYPAL_API_CLIENT_ID;
    delete process.env.PAYPAL_API_CLIENT_SECRET;

    let error;
    try {
      await new Paypal().listPlans();
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect(error.message).to.equal('PayPal credentials are not configured.');
    expect(nock.pendingMocks()).to.deep.equal([]);
  });

  it('rejects an empty access token instead of sending Bearer undefined', async function() {
    const token = mockAccessToken({});

    let error;
    try {
      await new Paypal().listPlans();
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect(error.message).to.equal('PayPal access token response is invalid.');
    expect(token.isDone()).to.equal(true);
    expect(nock.pendingMocks()).to.deep.equal([]);
  });

  it('rejects missing and oversized PayPal resource ids locally', async function() {
    const paypal = new Paypal();

    let emptyError;
    let oversizedError;
    try {
      await paypal.getSubscriptionDetails('');
    } catch (caught) {
      emptyError = caught;
    }
    try {
      await paypal.cancelPlan('x'.repeat(129));
    } catch (caught) {
      oversizedError = caught;
    }

    expect(emptyError).to.be.instanceOf(Error);
    expect(oversizedError).to.be.instanceOf(Error);
    expect(emptyError.message).to.equal('PayPal resource id is invalid.');
    expect(oversizedError.message).to.equal('PayPal resource id is invalid.');
  });
});

'use strict';

const axios = require('axios');
const devConfig = require('../../config/env/development');
const prodConfig = require('../../config/env/production');

const BASE_URL =
  process.env.SUBDOMAINS === 'app,api.app,wiki' &&
  process.env.URL === 'cboard.io'
    ? prodConfig.PAYPAL_API_URL + 'v1'
    : devConfig.PAYPAL_API_URL;
const MAX_RESOURCE_ID_LENGTH = 128;
const PLAN_PAGE_SIZE = 20;
const MAX_PLAN_PAGES = 100;

function normalizeResourceId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > MAX_RESOURCE_ID_LENGTH) {
    throw new Error('PayPal resource id is invalid.');
  }
  return encodeURIComponent(id);
}

async function getAccessToken() {
  const clientId = String(process.env.PAYPAL_API_CLIENT_ID || '').trim();
  const clientSecret = String(
    process.env.PAYPAL_API_CLIENT_SECRET || ''
  ).trim();
  if (!clientId || !clientSecret) {
    throw new Error('PayPal credentials are not configured.');
  }

  const response = await axios.post(
    BASE_URL + '/oauth2/token',
    new URLSearchParams({ grant_type: 'client_credentials' }),
    {
      auth: {
        username: clientId,
        password: clientSecret
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );
  const accessToken = String(
    response && response.data && response.data.access_token
      ? response.data.access_token
      : ''
  ).trim();
  if (!accessToken) {
    throw new Error('PayPal access token response is invalid.');
  }
  return accessToken;
}

module.exports = class Paypal {
  constructor(config = {}) {
    this.axiosInstance = axios.create({
      baseURL: BASE_URL,
      ...config
    });
  }

  async getAuthorizationHeaders() {
    const accessToken = await getAccessToken();
    return {
      Authorization: `Bearer ${accessToken}`
    };
  }

  async getSubscriptionDetails(subscriptionId) {
    const id = normalizeResourceId(subscriptionId);
    const headers = await this.getAuthorizationHeaders();
    const { data } = await this.axiosInstance.get(
      `/billing/subscriptions/${id}`,
      {
        headers
      }
    );
    return data;
  }

  async listPlans() {
    const headers = await this.getAuthorizationHeaders();
    const plans = [];
    let page = 1;
    let firstPage = {};

    while (page <= MAX_PLAN_PAGES) {
      const { data = {} } = await this.axiosInstance.get('/billing/plans', {
        headers,
        params: {
          page_size: PLAN_PAGE_SIZE,
          page,
          total_required: true
        }
      });
      if (page === 1) firstPage = data;

      const pagePlans = Array.isArray(data.plans) ? data.plans : [];
      plans.push(...pagePlans);

      const totalPages = Number(data.total_pages);
      const hasDocumentedTotal = Number.isInteger(totalPages) && totalPages > 0;
      if (hasDocumentedTotal && totalPages > MAX_PLAN_PAGES) {
        throw new Error('PayPal plan catalog exceeds pagination limit.');
      }

      const hasNextPage = hasDocumentedTotal
        ? page < totalPages
        : pagePlans.length === PLAN_PAGE_SIZE;
      if (!hasNextPage) {
        return {
          ...firstPage,
          plans,
          total_items:
            Number.isInteger(Number(firstPage.total_items)) &&
            Number(firstPage.total_items) >= 0
              ? Number(firstPage.total_items)
              : plans.length,
          total_pages: hasDocumentedTotal ? totalPages : page
        };
      }
      page += 1;
    }

    throw new Error('PayPal plan catalog exceeds pagination limit.');
  }

  async cancelPlan(subscriptionId) {
    const id = normalizeResourceId(subscriptionId);
    const headers = await this.getAuthorizationHeaders();
    const { data } = await this.axiosInstance.post(
      `/billing/subscriptions/${id}/cancel`,
      { reason: 'User cancelled' },
      { headers }
    );
    return data;
  }
};

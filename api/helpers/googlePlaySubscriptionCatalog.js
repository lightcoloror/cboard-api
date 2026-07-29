'use strict';

const GOOGLE_PLAY_SUBSCRIPTION_PAGE_SIZE = 1000;
const MAX_GOOGLE_PLAY_SUBSCRIPTION_PAGES = 100;
const MAX_GOOGLE_PLAY_PAGE_TOKEN_LENGTH = 4096;

function getSubscriptionListMethod(client) {
  const list =
    client &&
    client.monetization &&
    client.monetization.subscriptions &&
    client.monetization.subscriptions.list;
  if (typeof list !== 'function') {
    throw new Error('Google Play subscription list client is unavailable.');
  }
  return list.bind(client.monetization.subscriptions);
}

function normalizeNextPageToken(value) {
  if (value === undefined || value === null || value === '') return '';
  if (
    typeof value !== 'string' ||
    value.length > MAX_GOOGLE_PLAY_PAGE_TOKEN_LENGTH
  ) {
    throw new Error('Google Play subscription page token is invalid.');
  }
  return value;
}

async function listAllGooglePlaySubscriptions({ client, packageName }) {
  const normalizedPackageName = String(packageName || '').trim();
  if (!normalizedPackageName) {
    throw new Error('Google Play package name is required.');
  }

  const list = getSubscriptionListMethod(client);
  const subscriptions = [];
  const seenTokens = new Set();
  let pageToken = '';

  for (let page = 0; page < MAX_GOOGLE_PLAY_SUBSCRIPTION_PAGES; page += 1) {
    const params = {
      packageName: normalizedPackageName,
      pageSize: GOOGLE_PLAY_SUBSCRIPTION_PAGE_SIZE
    };
    if (pageToken) params.pageToken = pageToken;

    const response = await list(params);
    const data = response && response.data ? response.data : {};
    if (
      data.subscriptions !== undefined &&
      !Array.isArray(data.subscriptions)
    ) {
      throw new Error('Google Play subscription list response is invalid.');
    }
    subscriptions.push(...(data.subscriptions || []));

    const nextPageToken = normalizeNextPageToken(data.nextPageToken);
    if (!nextPageToken) return subscriptions;
    if (seenTokens.has(nextPageToken)) {
      throw new Error('Google Play subscription pagination repeated a token.');
    }
    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  throw new Error('Google Play subscription catalog exceeds pagination limit.');
}

module.exports = {
  GOOGLE_PLAY_SUBSCRIPTION_PAGE_SIZE,
  MAX_GOOGLE_PLAY_SUBSCRIPTION_PAGES,
  MAX_GOOGLE_PLAY_PAGE_TOKEN_LENGTH,
  listAllGooglePlaySubscriptions
};

'use strict';

const ACTIVE_SUBSCRIBER_STATUSES = new Set([
  'active',
  'in_grace_period'
]);
const CANCELED_SUBSCRIBER_STATUSES = new Set([
  'canceled',
  'cancelled'
]);
const MAX_ANDROID_RECEIPT_LENGTH = 64 * 1024;
const MAX_ANDROID_PURCHASE_TOKEN_LENGTH = 4096;

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return typeof value.toObject === 'function' ? value.toObject() : value;
}

function boundedText(value, maximum) {
  return String(value || '').trim().slice(0, maximum);
}

function copyPrice(value) {
  if (typeof value === 'string') return boundedText(value, 80);
  const source = asObject(value);
  const result = {};
  const currencyCode = boundedText(source.currencyCode, 12);
  if (currencyCode) result.currencyCode = currencyCode;
  if (source.units !== undefined) {
    result.units = typeof source.units === 'number'
      ? source.units
      : boundedText(source.units, 32);
  }
  if (source.nanos !== undefined && Number.isFinite(Number(source.nanos))) {
    result.nanos = Number(source.nanos);
  }
  return result;
}

function boundedScalar(value, maximum) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return boundedText(value, maximum);
}

function parseAndroidNativePurchase(value) {
  const source = asObject(value);
  const receipt = source.receipt;
  if (receipt === undefined) return source;
  if (
    typeof receipt !== 'string' ||
    receipt.length > MAX_ANDROID_RECEIPT_LENGTH
  ) {
    throw new Error('Android purchase receipt is invalid.');
  }
  let parsed;
  try {
    parsed = JSON.parse(receipt);
  } catch (error) {
    throw new Error('Android purchase receipt is invalid.');
  }
  return {
    ...source,
    ...asObject(parsed),
    receipt: undefined
  };
}

function buildAndroidPurchaseTransaction({ body, catalogProduct }) {
  const request = asObject(body);
  const product = normalizeSelectedProduct(catalogProduct);
  const purchase = parseAndroidNativePurchase(request.nativePurchase);
  const productId = boundedText(purchase.productId, 128);
  const rawPurchaseToken = String(purchase.purchaseToken || '').trim();
  if (
    productId !== product.subscriptionId ||
    !rawPurchaseToken ||
    rawPurchaseToken.length > MAX_ANDROID_PURCHASE_TOKEN_LENGTH
  ) {
    throw new Error('Android purchase does not match the selected product.');
  }

  const transactionId = boundedText(
    request.transactionId || purchase.orderId,
    256
  );
  if (!transactionId) throw new Error('Transaction id is required.');

  const nativePurchase = {
    orderId: boundedScalar(purchase.orderId, 256),
    packageName: boundedScalar(purchase.packageName, 256),
    productId: product.subscriptionId,
    purchaseTime: boundedScalar(purchase.purchaseTime, 64),
    purchaseState: boundedScalar(purchase.purchaseState, 40),
    purchaseToken: rawPurchaseToken,
    quantity: Number.isFinite(Number(purchase.quantity))
      ? Math.max(0, Math.min(10000, Number(purchase.quantity)))
      : undefined,
    autoRenewing: purchase.autoRenewing === true,
    acknowledged: purchase.acknowledged === true
  };
  Object.keys(nativePurchase).forEach(key => {
    if (nativePurchase[key] === undefined) delete nativePurchase[key];
  });

  return {
    platform: 'android-playstore',
    transactionId,
    state: 'approved',
    nativePurchase,
    purchaseId: boundedText(request.purchaseId, 512),
    purchaseDate: boundedText(request.purchaseDate, 64),
    isPending: request.isPending === true,
    isAcknowledged: request.isAcknowledged === true,
    renewalIntent: boundedText(request.renewalIntent, 40)
  };
}

function normalizeSelectedProduct(value) {
  const source = asObject(value);
  const product = {
    subscriptionId: boundedText(source.subscriptionId, 128),
    planId: boundedText(source.planId || source.id, 128),
    paypalId: boundedText(source.paypalId, 128),
    title: boundedText(source.title, 160),
    billingPeriod: boundedText(source.billingPeriod, 40),
    price: copyPrice(source.price),
    tag: boundedText(source.tag, 80)
  };
  if (!product.subscriptionId) {
    throw new Error('A subscription product id is required.');
  }
  return product;
}

function getPlanPrice(plan, country) {
  const countries = Array.isArray(plan.countries) ? plan.countries : [];
  const normalizedCountry = boundedText(country, 80).toUpperCase();
  const matching = countries.find(item => {
    const entry = asObject(item);
    return boundedText(entry.regionCode, 80).toUpperCase() === normalizedCountry;
  });
  const fallback = countries.find(item => asObject(item).price !== undefined);
  const entry = asObject(matching || fallback);
  return copyPrice(entry.price);
}

async function resolveCatalogProduct({ Subscription, selectedProduct, country }) {
  const selected = normalizeSelectedProduct(selectedProduct);
  const query = Subscription.findOne({ subscriptionId: selected.subscriptionId });
  const subscription = query && typeof query.exec === 'function'
    ? await query.exec()
    : await query;
  if (!subscription || boundedText(subscription.status, 40).toLowerCase() !== 'active') {
    throw new Error('The selected subscription is not available.');
  }

  const plans = (Array.isArray(subscription.plans) ? subscription.plans : [])
    .filter(plan => boundedText(plan.status, 40).toLowerCase() === 'active');
  let plan = null;
  if (selected.planId) {
    plan = plans.find(item => boundedText(item.planId, 128) === selected.planId);
  }
  if (!plan && selected.paypalId) {
    plan = plans.find(item => boundedText(item.paypalId, 128) === selected.paypalId);
  }
  if (!plan && plans.length === 1) plan = plans[0];
  if (!plan) throw new Error('The selected subscription plan is not available.');

  const planId = boundedText(plan.planId, 128);
  const paypalId = boundedText(plan.paypalId, 128);
  if (selected.planId && selected.planId !== planId) {
    throw new Error('The selected subscription plan does not match the catalog.');
  }
  if (selected.paypalId && selected.paypalId !== paypalId) {
    throw new Error('The selected PayPal plan does not match the catalog.');
  }

  return {
    subscriptionId: boundedText(subscription.subscriptionId, 128),
    planId,
    paypalId,
    title: boundedText(subscription.name, 160),
    billingPeriod: boundedText(plan.period, 40),
    price: getPlanPrice(plan, country),
    tag: boundedText(Array.isArray(plan.tags) ? plan.tags[0] : '', 80)
  };
}

function normalizePaypalStatus(value) {
  const status = boundedText(value, 40).toLowerCase();
  return status === 'cancelled' ? 'canceled' : status;
}

function buildVerifiedPaypalTransaction({ remoteData, subscriber }) {
  const remote = asObject(remoteData);
  const product = normalizeSelectedProduct(subscriber.product);
  const remoteId = boundedText(remote.id, 128);
  const remotePlanId = boundedText(remote.plan_id, 128);
  const remoteUserId = boundedText(remote.custom_id, 128);
  const status = normalizePaypalStatus(remote.status);
  if (!remoteId) throw new Error('PayPal did not return a subscription id.');
  if (!remoteUserId || remoteUserId !== boundedText(subscriber.userId, 128)) {
    throw new Error('PayPal subscription owner does not match the CBoard account.');
  }
  if (!product.paypalId || remotePlanId !== product.paypalId) {
    throw new Error('PayPal subscription plan does not match the selected product.');
  }
  if (status !== 'active') {
    throw new Error('PayPal subscription is not active.');
  }

  const billingInfo = asObject(remote.billing_info);
  const nextBillingTime = boundedText(billingInfo.next_billing_time, 64);
  const startTime = boundedText(remote.start_time, 64);
  return {
    platform: 'paypal',
    subscriptionId: remoteId,
    transactionId: remoteId,
    state: 'approved',
    subscriptionState: status,
    expiryDate: nextBillingTime,
    purchaseDate: startTime,
    isPending: false,
    nativePurchase: {
      id: remoteId,
      status: boundedText(remote.status, 40),
      plan_id: remotePlanId,
      custom_id: remoteUserId,
      start_time: startTime,
      billing_info: nextBillingTime
        ? { next_billing_time: nextBillingTime }
        : {}
    }
  };
}

function sanitizeNativePurchase(value) {
  const source = asObject(value);
  const safe = {};
  [
    'id',
    'status',
    'plan_id',
    'custom_id',
    'start_time',
    'orderId',
    'packageName',
    'productId',
    'purchaseTime',
    'purchaseState',
    'quantity',
    'autoRenewing',
    'acknowledged'
  ].forEach(key => {
    if (source[key] !== undefined) safe[key] = source[key];
  });
  const nextBillingTime = boundedText(
    asObject(source.billing_info).next_billing_time,
    64
  );
  if (nextBillingTime) {
    safe.billing_info = { next_billing_time: nextBillingTime };
  }
  return safe;
}

function sanitizeTransaction(value) {
  const source = asObject(value);
  if (!Object.keys(source).length) return null;
  const safe = {};
  [
    'platform',
    'subscriptionId',
    'transactionId',
    'productId',
    'state',
    'subscriptionState',
    'expiryDate',
    'purchaseDate',
    'isPending',
    'isExpired',
    'isBillingRetryPeriod',
    'isAcknowledged',
    'renewalIntent'
  ].forEach(key => {
    if (source[key] !== undefined) safe[key] = source[key];
  });
  const nativePurchase = sanitizeNativePurchase(source.nativePurchase);
  if (Object.keys(nativePurchase).length) safe.nativePurchase = nativePurchase;
  return safe;
}

function sanitizeProduct(value) {
  if (!value) return null;
  const source = asObject(value);
  const product = normalizeSelectedProduct(source);
  ['_id', 'createdAt', 'updatedAt'].forEach(key => {
    if (source[key] !== undefined) product[key] = source[key];
  });
  return product;
}

function sanitizeSubscriber(value) {
  const source = asObject(value);
  return {
    _id: source._id,
    userId: boundedText(source.userId, 128),
    country: boundedText(source.country, 80),
    status: normalizePaypalStatus(source.status) || 'not_subscribed',
    product: source.product ? sanitizeProduct(source.product) : null,
    transaction: sanitizeTransaction(source.transaction),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt
  };
}

function isSubscriberActive(value, now = new Date()) {
  const source = asObject(value);
  const status = boundedText(
    typeof value === 'string' ? value : source.status,
    40
  ).toLowerCase();
  if (ACTIVE_SUBSCRIBER_STATUSES.has(status)) return true;
  if (!CANCELED_SUBSCRIBER_STATUSES.has(status)) return false;

  const expiryDate =
    asObject(source.transaction).expiryDate || source.expiryDate;
  if (!expiryDate) return true;

  const expiryTime = new Date(expiryDate).getTime();
  const comparisonTime = new Date(now).getTime();
  if (!Number.isFinite(expiryTime) || !Number.isFinite(comparisonTime)) {
    return true;
  }
  return expiryTime > comparisonTime;
}

module.exports = {
  MAX_ANDROID_PURCHASE_TOKEN_LENGTH,
  MAX_ANDROID_RECEIPT_LENGTH,
  buildAndroidPurchaseTransaction,
  buildVerifiedPaypalTransaction,
  isSubscriberActive,
  normalizeSelectedProduct,
  resolveCatalogProduct,
  sanitizeSubscriber,
  sanitizeTransaction
};

'use strict';

function normalizeSubscriptionId(value, source) {
  const subscriptionId = String(value || '').trim();
  if (!subscriptionId || subscriptionId.length > 128) {
    throw new Error(`${source} subscription id is invalid.`);
  }
  return subscriptionId;
}

async function executeQuery(query, errorMessage) {
  if (!query) throw new Error(errorMessage);
  const result =
    typeof query.exec === 'function' ? await query.exec() : await query;
  if (!Array.isArray(result)) throw new Error(errorMessage);
  return result;
}

async function reconcileStaleLocalSubscriptions({
  Subscription,
  remoteSubscriptions
}) {
  if (
    !Subscription ||
    typeof Subscription.find !== 'function' ||
    typeof Subscription.findOneAndDelete !== 'function'
  ) {
    throw new Error('Local subscription catalog model is unavailable.');
  }
  if (!Array.isArray(remoteSubscriptions)) {
    throw new Error('Remote subscription catalog is invalid.');
  }

  const remoteIds = new Set(
    remoteSubscriptions.map(subscription =>
      normalizeSubscriptionId(subscription && subscription.productId, 'Remote')
    )
  );
  const localSubscriptions = await executeQuery(
    Subscription.find({}),
    'Local subscription catalog response is invalid.'
  );
  const localEntries = localSubscriptions.map(subscription => ({
    subscription,
    subscriptionId: normalizeSubscriptionId(
      subscription && subscription.subscriptionId,
      'Local'
    )
  }));
  const staleEntries = localEntries.filter(
    entry => !remoteIds.has(entry.subscriptionId)
  );
  const deleted = [];

  for (const entry of staleEntries) {
    const removed = await Subscription.findOneAndDelete({
      subscriptionId: entry.subscriptionId
    });
    if (removed) deleted.push(removed);
  }

  return {
    deleted,
    localCount: localEntries.length,
    remoteCount: remoteIds.size,
    retainedCount: localEntries.length - deleted.length
  };
}

module.exports = {
  reconcileStaleLocalSubscriptions
};

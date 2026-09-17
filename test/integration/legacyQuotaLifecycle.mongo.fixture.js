'use strict';

const assert = require('assert').strict;
const {
  createCommunicationAiTokenQuotaLimiter,
  createCommunicationAiTokenQuotaService
} = require('../../api/helpers/communicationAiTokenQuota');
const { createCareFamilyLifecycle } = require('../../api/helpers/careFamilyLifecycle');
const {
  buildMonthlyRateLimitKey,
  hashRateLimitIdentity
} = require('../../api/helpers/communicationEnhancementRateLimit');

module.exports = async function legacyQuotaLifecycleMongoFixture({
  mongoose,
  coordinator,
  passed
}) {
  const previousFlag = process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
  process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
  const connection = mongoose.connection;
  const quotaConfig = {
    enabled: true,
    monthlyTokens: 20,
    textReservationTokens: 10,
    imageReservationTokens: 10
  };
  const now = () => new Date('2026-08-15T00:00:00.000Z');
  const quotaLimiter = createCommunicationAiTokenQuotaLimiter({
    storeClient: connection,
    config: quotaConfig
  });
  await quotaLimiter.createIndexes();
  const lifecycle = createCareFamilyLifecycle({ connection });
  const service = createCommunicationAiTokenQuotaService({
    config: quotaConfig,
    limiter: quotaLimiter,
    lifecycle,
    lifecycleEnabled: () => true,
    now
  });
  const quotaCollection = connection.db.collection('communicationAiMonthlyTokenQuotas');
  const accountCollection = connection.db.collection('careaccountlifecycles');
  const userCollection = connection.db.collection('users');
  const owner = String(new mongoose.Types.ObjectId());
  const controlOwner = String(new mongoose.Types.ObjectId());
  const closedOwner = String(new mongoose.Types.ObjectId());
  const callbackOwner = String(new mongoose.Types.ObjectId());
  const owners = [owner, controlOwner, closedOwner, callbackOwner];

  try {
    await userCollection.insertMany(owners.map((id, index) => ({
      _id: new mongoose.Types.ObjectId(id),
      name: `Synthetic quota user ${index}`,
      email: `quota-${id}@example.test`,
      password: 'synthetic-password'
    })));
    await accountCollection.insertMany(owners.map(id => ({
      _id: id,
      status: 'open',
      lifecycleRev: 0
    })));

    const first = await service.reserve({
      operationId: 'generateCommunicationSentences', userId: owner
    });
    const second = await service.reserve({
      operationId: 'generateCommunicationSentences', userId: owner
    });
    await service.settleReservation(first, { total_tokens: 4 });
    await service.settleReservation(second, { total_tokens: 12 });
    assert.equal((await service.getStatus({ userId: owner })).consumedTokens, 16);
    const releaseReservation = await service.reserve({
      operationId: 'generateCommunicationSentences', userId: controlOwner
    });
    assert.equal(await service.releaseReservation(releaseReservation), true);
    assert.equal((await service.getStatus({ userId: controlOwner })).consumedTokens, 0);
    passed.push('legacy-quota-settle-refund-penalty-release');

    const concurrent = await Promise.allSettled(
      Array.from({ length: 10 }, () => service.reserve({
        operationId: 'generateCommunicationSentences', userId: controlOwner
      }))
    );
    const concurrentSuccesses = concurrent.filter(result => result.status === 'fulfilled');
    const concurrentFailures = concurrent.filter(result => result.status === 'rejected');
    assert.equal(concurrentSuccesses.length, 2);
    assert.equal(concurrentFailures.length, 8);
    assert(concurrentFailures.every(result => result.reason.status === 429));
    const concurrentStatus = await service.getStatus({ userId: controlOwner });
    assert.equal(concurrentStatus.consumedTokens, 20);
    passed.push('legacy-quota-concurrent-reservations-rollback');

    const oldMonth = new Date('2026-07-15T00:00:00.000Z');
    const oldKey = buildMonthlyRateLimitKey(hashRateLimitIdentity(owner), oldMonth);
    const controlOldKey = buildMonthlyRateLimitKey(hashRateLimitIdentity(controlOwner), oldMonth);
    await quotaLimiter.consume(oldKey, 1, { customDuration: 3600 });
    await quotaLimiter.consume(controlOldKey, 1, { customDuration: 3600 });
    await assert.rejects(service.deleteUserQuota({ userId: owner }),
      error => error.code === 'COMMUNICATION_AI_TOKEN_QUOTA_UNAVAILABLE');
    assert.equal(await quotaCollection.countDocuments({ key: { $regex: hashRateLimitIdentity(owner) } }), 2);
    await coordinator.begin(owner, []);
    assert.equal(await service.deleteUserQuota({ userId: owner }), true);
    assert.equal(await quotaCollection.countDocuments({ key: { $regex: hashRateLimitIdentity(owner) } }), 0);
    assert.equal(await quotaCollection.countDocuments({ key: { $regex: hashRateLimitIdentity(controlOwner) } }) > 0, true);
    await quotaLimiter.consume(oldKey, 1, { customDuration: 3600 });
    const disabledService = createCommunicationAiTokenQuotaService({
      config: { ...quotaConfig, enabled: false },
      limiter: quotaLimiter,
      lifecycleEnabled: () => true,
      now
    });
    assert.equal(await disabledService.deleteUserQuota({ userId: owner }), true);
    assert.equal(await quotaCollection.countDocuments({ key: { $regex: hashRateLimitIdentity(owner) } }), 0);
    passed.push('legacy-quota-delete-all-months-preserves-other-owner');

    const late = await service.reserve({
      operationId: 'generateCommunicationSentences', userId: closedOwner
    });
    await coordinator.begin(closedOwner, []);
    assert.equal(await service.deleteUserQuota({ userId: closedOwner }), true);
    for (const status of ['closing', 'closed']) {
      await accountCollection.updateOne({ _id: closedOwner }, { $set: { status } });
      for (const operation of [
        () => service.reserve({ operationId: 'generateCommunicationSentences', userId: closedOwner }),
        () => service.settleReservation(late, { total_tokens: 4 }),
        () => service.settleReservation(late, { total_tokens: 30 }),
        () => service.releaseReservation(late)
      ]) {
        await assert.rejects(operation(), error =>
          error.code === (status === 'closed' ? 'ACCOUNT_CLOSED' : 'ACCOUNT_CLOSING'));
        assert.equal(await quotaCollection.countDocuments({ key: { $regex: hashRateLimitIdentity(closedOwner) } }), 0);
      }
    }
    passed.push('legacy-quota-closing-and-closed-block-late-recreation-after-cleanup');

    const callbackLifecycle = {
      async withOpenAccount(accountId, callback) {
        return lifecycle.withOpenAccount(accountId, async session => {
          await callback(session);
          throw new Error('synthetic quota transaction abort');
        });
      }
    };
    const transactionalFailureService = createCommunicationAiTokenQuotaService({
      config: quotaConfig,
      limiter: quotaLimiter,
      lifecycle: callbackLifecycle,
      lifecycleEnabled: () => true,
      now
    });
    await assert.rejects(
      transactionalFailureService.reserve({
        operationId: 'generateCommunicationSentences', userId: callbackOwner
      }),
      error => error.code === 'COMMUNICATION_AI_TOKEN_QUOTA_UNAVAILABLE'
    );
    assert.equal(await quotaCollection.countDocuments({ key: { $regex: hashRateLimitIdentity(callbackOwner) } }), 0);
    passed.push('legacy-quota-transaction-abort-rolls-back-reservation');
  } finally {
    if (previousFlag === undefined) delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    else process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = previousFlag;
  }
};

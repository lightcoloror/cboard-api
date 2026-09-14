'use strict';
// Explicit isolated-Mongo contract only.  It never starts a service and never
// falls back to a default URI.  Run only with CARE_TEST_MONGO_URI.
const assert = require('assert').strict;
const crypto = require('crypto');
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.CARE_TEST_MONGO_URI;
  if (!uri || !/^mongodb:\/\/[^/]+\/care_test_[a-f0-9]+$/.test(uri)) throw new Error('Explicit isolated care_test database required');
  const databaseName = uri.split('/').pop();
  process.env.CARE_ENCRYPTION_ACTIVE_KEY = 'test';
  process.env.CARE_ENCRYPTION_KEYS = JSON.stringify({ test: crypto.randomBytes(32).toString('hex') });
  await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  try {
    const { Family, Account } = require('../../api/models/CareWorkspace');
    const { Funding, store: fundingStore } = require('../../api/helpers/careBudgetRuntime');
    const { store: careStore } = require('../../api/helpers/careRuntime');
    const { createCareCrypto } = require('../../api/helpers/careCrypto');
    const { createCareBudget } = require('../../api/helpers/careBudget');
    const { createCareSubscription } = require('../../api/helpers/careSubscription');
    const { createCareTrialClaim } = require('../../api/helpers/careTrialClaim');
    const encryption = createCareCrypto(JSON.parse(process.env.CARE_ENCRYPTION_KEYS), 'test');
    const policy = { version: 'mongo-v1', trialUnits: 12, weeklyLimit: 4, trialDurationMs: 3 * 86400000, subscriptionDurationMs: 7 * 86400000 };
    const makeClaim = ({ budget = createCareBudget({ store: fundingStore, encryption, now: () => 1000 }) } = {}) => createCareTrialClaim({
      accountStore: { get: careStore.getAccount, create: careStore.createAccount, cas: careStore.casAccount },
      familyStore: { get: careStore.getFamily, cas: careStore.casFamily }, fundingStore, encryption, budget,
      subscription: createCareSubscription({ store: { getFamily: careStore.getFamily, casFamily: careStore.casFamily }, encryption }),
      accountEligibility: { isVerified: async () => true }, policy, now: () => 1000
    });
    const addFamily = (id, owner) => Family.create({ _id: id, owner, rev: 0, sealed: encryption.seal({ name: id, subscription: null }, `family:${id}`) });

    await addFamily('family-a', 'user-a'); await addFamily('family-b', 'user-a');
    const concurrent = await Promise.allSettled([makeClaim().claim('user-a', 'family-a'), makeClaim().claim('user-a', 'family-b')]);
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.find(result => result.status === 'rejected').reason.code, 'TRIAL_ACCOUNT_ALREADY_CLAIMED');
    assert.equal(await Account.countDocuments({}), 1); assert.equal(await Funding.countDocuments({}), 1);

    await addFamily('family-c', 'user-c');
    const realBudget = createCareBudget({ store: fundingStore, encryption, now: () => 1000 });
    let failOnce = true;
    const interrupted = { ...realBudget, addPack: async (...args) => {
      if (failOnce) { failOnce = false; const error = new Error('synthetic interruption'); error.code = 'INTERRUPTED'; throw error; }
      return realBudget.addPack(...args);
    } };
    const pending = makeClaim({ budget: interrupted });
    await assert.rejects(pending.claim('user-c', 'family-c'), error => error.code === 'INTERRUPTED');
    const recovered = await makeClaim().claim('user-c', 'family-c');
    assert.equal(recovered.status, 'complete');
    assert.equal(await Funding.countDocuments({}), 2);
    console.log(JSON.stringify({ result: 'passed', careTrialMongo: true, syntheticOnly: true, productionDatabaseTouched: false }));
  } finally {
    if (mongoose.connection.name !== databaseName) throw new Error('Cleanup database guard failed');
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
}
main().catch(async error => { console.error(error.name, error.code || error.message); await mongoose.disconnect(); process.exitCode = 1; });

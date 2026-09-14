'use strict';

const { createCareBudget } = require('./careBudget');
const { createCareSubscription } = require('./careSubscription');
const { createCareTrialClaim } = require('./careTrialClaim');
const User = require('../models/User');

function policyFromEnvironment(value = process.env.CARE_TRIAL_POLICY_JSON) {
  try { return value ? JSON.parse(value) : null; } catch (_) { return null; }
}

function createRuntime({ policy = policyFromEnvironment(), encryption = require('./careCrypto').fromEnvironment(), accountStore = require('./careRuntime').store, fundingStore = require('./careBudgetRuntime').store, accountEligibility = { isVerified: async accountId => Boolean(await User.findById(accountId).select('_id').lean().exec()) } } = {}) {
  const trialAccountStore = {
    get: accountStore.getAccount,
    create: accountStore.createAccount,
    cas: accountStore.casAccount
  };
  const trialFamilyStore = {
    get: accountStore.getFamily,
    cas: accountStore.casFamily
  };
  const budget = createCareBudget({ store: fundingStore, encryption });
  const subscription = createCareSubscription({
    store: { getFamily: trialFamilyStore.get, casFamily: trialFamilyStore.cas },
    encryption
  });
  return createCareTrialClaim({ accountStore: trialAccountStore, familyStore: trialFamilyStore, fundingStore, encryption, subscription, budget, accountEligibility, policy });
}

module.exports = { createRuntime, policyFromEnvironment };

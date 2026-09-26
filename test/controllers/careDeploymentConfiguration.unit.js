'use strict';

const assert = require('assert').strict;
const crypto = require('crypto');
const {
  OPERATIONS,
  validateCareAiPricePolicy
} = require('../../api/helpers/careAiMetering');
const {
  validateCareDeploymentConfiguration
} = require('../../scripts/checkCareDeploymentConfiguration');

const key = 'a'.repeat(64);
const trialPolicy = {
  version: 'public-v1', trialUnits: 12, weeklyLimit: 4,
  trialDurationMs: 3000, subscriptionDurationMs: 7000
};
const aiPolicy = Object.fromEntries([...OPERATIONS].map(operation => [operation, {
  reservationUnits: 10, fixedUnits: 1, tokensPerUnit: 10
}]));

function complete(overrides = {}) {
  return {
    CARE_COLLABORATION_ENABLED: 'true',
    CARE_NEXT_ENABLED: 'true',
    CARE_PUBLIC_TRIAL_ENABLED: 'true',
    CARE_LIFECYCLE_TRANSACTIONS_ENABLED: 'true',
    CARE_CLOSURE_CONFIRMATION_ENABLED: 'true',
    CARE_ENCRYPTION_ACTIVE_KEY: 'primary',
    CARE_ENCRYPTION_KEYS: JSON.stringify({ primary: key }),
    CARE_TRIAL_POLICY_JSON: JSON.stringify(trialPolicy),
    CARE_AI_PRICE_POLICY: JSON.stringify(aiPolicy),
    CARE_FAMILY_MEDIA_QUOTA_BYTES: '1048576',
    CARE_FAMILY_MEDIA_QUOTA_MAX_FILES: '10',
    MONGO_URL: 'mongodb://cboard:secret@mongo:27017/cboard?authSource=admin&replicaSet=care-rs',
    ...overrides
  };
}

describe('Care deployment configuration validator', function() {
  it('does nothing when every Care switch is disabled', function() {
    assert.deepEqual(validateCareDeploymentConfiguration({
      CARE_ENCRYPTION_KEYS: '{bad',
      CARE_ENCRYPTION_ACTIVE_KEY: 'missing',
      CARE_FAMILY_MEDIA_QUOTA_BYTES: '0',
      CARE_FAMILY_MEDIA_QUOTA_MAX_FILES: '0',
      CARE_AI_PRICE_POLICY: '{bad',
      MONGO_URL: 'mongodb://standalone'
    }), []);
  });

  it('requires the complete public trial switch set and policy', function() {
    const errors = validateCareDeploymentConfiguration({
      CARE_PUBLIC_TRIAL_ENABLED: 'true',
      CARE_ENCRYPTION_KEYS: JSON.stringify({ primary: key }),
      CARE_ENCRYPTION_ACTIVE_KEY: 'primary',
      CARE_FAMILY_MEDIA_QUOTA_BYTES: '1',
      CARE_FAMILY_MEDIA_QUOTA_MAX_FILES: '1',
      MONGO_URL: 'mongodb://mongo/db?replicaSet=care-rs'
    });
    assert(errors.some(value => value.includes('CARE_COLLABORATION_ENABLED')));
    assert(errors.some(value => value.includes('CARE_NEXT_ENABLED')));
    assert(errors.some(value => value.includes('CARE_LIFECYCLE_TRANSACTIONS_ENABLED')));
    assert(errors.some(value => value.includes('CARE_CLOSURE_CONFIRMATION_ENABLED')));
    assert(errors.some(value => value.includes('CARE_TRIAL_POLICY_JSON')));
  });

  it('accepts a complete syntactic Care configuration', function() {
    assert.deepEqual(validateCareDeploymentConfiguration(complete()), []);
  });

  it('rejects driver case-insensitive direct connections and duplicate replica options', function() {
    for (const suffix of ['&directConnection=true', '&DIRECTCONNECTION=true', '&ReplicaSet=other', '&replicaSet=other']) {
      const env = complete();
      env.MONGO_URL += suffix;
      assert(validateCareDeploymentConfiguration(env).some(value => value.includes('replicaSet')));
    }
  });

  it('checks quota, encryption, AI prices and replicaSet without exposing secrets', function() {
    const secret = crypto.randomBytes(32).toString('hex');
    const errors = validateCareDeploymentConfiguration(complete({
      CARE_ENCRYPTION_ACTIVE_KEY: 'wrong',
      CARE_ENCRYPTION_KEYS: JSON.stringify({ primary: secret }),
      CARE_FAMILY_MEDIA_QUOTA_BYTES: '',
      CARE_FAMILY_MEDIA_QUOTA_MAX_FILES: '',
      CARE_AI_PRICE_POLICY: JSON.stringify({}),
      MONGO_URL: 'mongodb://cboard:private-password@mongo:27017/cboard?authSource=admin&replicaSet='
    }));
    assert(errors.some(value => value.includes('seal/open probe')));
    assert(errors.some(value => value.includes('media quota')));
    assert(errors.some(value => value.includes('CARE_AI_PRICE_POLICY')));
    assert(errors.some(value => value.includes('replicaSet')));
    assert(!errors.join(' ').includes(secret));
    assert(!errors.join(' ').includes('private-password'));
  });

  it('shares the AI price shape validator with request metering', function() {
    assert.equal(validateCareAiPricePolicy(aiPolicy), true);
    const invalid = { ...aiPolicy, editPhrase: { reservationUnits: 0, fixedUnits: 0 } };
    assert.equal(validateCareAiPricePolicy(invalid), false);
    assert.equal(validateCareAiPricePolicy(aiPolicy, 'editPhrase'), true);
    assert.equal(validateCareAiPricePolicy(invalid, 'editPhrase'), false);
  });
});

'use strict';

const { createCareCrypto } = require('../api/helpers/careCrypto');
const { resolveCareMediaQuotaConfig } = require('../api/helpers/careMediaQuota');
const { validatePolicy } = require('../api/helpers/careTrialClaim');
const {
  OPERATIONS,
  validateCareAiPricePolicy
} = require('../api/helpers/careAiMetering');

const CARE_SWITCHES = [
  'CARE_COLLABORATION_ENABLED',
  'CARE_NEXT_ENABLED',
  'CARE_PUBLIC_TRIAL_ENABLED',
  'CARE_LIFECYCLE_TRANSACTIONS_ENABLED',
  'CARE_CLOSURE_CONFIRMATION_ENABLED',
  'CARE_CLOSURE_WORKER_ENABLED'
];

function enabled(value) {
  return value === 'true';
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch (_) {
    return null;
  }
}

function hasReplicaSet(mongoUrl) {
  try {
    const parsed = new URL(String(mongoUrl || ''));
    if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)) return false;
    const keys = [...parsed.searchParams.keys()].map(key => key.toLowerCase());
    if (keys.includes('directconnection') || keys.filter(key => key === 'replicaset').length !== 1) return false;
    return Boolean(String(parsed.searchParams.get('replicaSet') || '').trim());
  } catch (_) {
    return false;
  }
}

function validateCareEncryption(env, errors) {
  const keys = parseJson(env.CARE_ENCRYPTION_KEYS);
  const active = env.CARE_ENCRYPTION_ACTIVE_KEY;
  try {
    const crypto = createCareCrypto(keys, active);
    const context = 'care-deployment-configuration-probe';
    const value = { probe: true };
    const sealed = crypto.seal(value, context);
    const opened = crypto.open(sealed, context);
    if (!opened || opened.probe !== true) throw new Error('probe mismatch');
  } catch (_) {
    errors.push(
      'Care encryption must pass an in-memory seal/open probe with a valid active key.'
    );
  }
}

function validateTrialPolicy(env, errors) {
  if (!validatePolicy(parseJson(env.CARE_TRIAL_POLICY_JSON))) {
    errors.push('CARE_TRIAL_POLICY_JSON must contain a valid Care trial policy.');
  }
}

function validateAiPrices(env, errors) {
  const prices = parseJson(env.CARE_AI_PRICE_POLICY);
  if (!validateCareAiPricePolicy(prices)) {
    errors.push(
      `CARE_AI_PRICE_POLICY must configure every Care AI operation: ${[...OPERATIONS].join(', ')}.`
    );
  }
}

function validateCareDeploymentConfiguration(env = {}) {
  const values = env || {};
  const publicTrial = enabled(values.CARE_PUBLIC_TRIAL_ENABLED);
  const careEnabled = CARE_SWITCHES.some(key => enabled(values[key]));
  if (!careEnabled) return [];

  const errors = [];
  if (publicTrial) {
    for (const key of [
      'CARE_COLLABORATION_ENABLED',
      'CARE_NEXT_ENABLED',
      'CARE_LIFECYCLE_TRANSACTIONS_ENABLED',
      'CARE_CLOSURE_CONFIRMATION_ENABLED'
    ]) {
      if (!enabled(values[key])) {
        errors.push(`CARE_PUBLIC_TRIAL_ENABLED requires ${key}=true.`);
      }
    }
    validateTrialPolicy(values, errors);
  }

  validateCareEncryption(values, errors);
  if (!resolveCareMediaQuotaConfig(values).available) {
    errors.push(
      'Care media quota requires positive CARE_FAMILY_MEDIA_QUOTA_BYTES and CARE_FAMILY_MEDIA_QUOTA_MAX_FILES.'
    );
  }
  if (enabled(values.CARE_NEXT_ENABLED)) validateAiPrices(values, errors);
  if (!hasReplicaSet(values.MONGO_URL)) {
    errors.push(
      'Care transactions require a non-empty replicaSet parameter in MONGO_URL; this check is syntactic only.'
    );
  }
  return errors;
}

module.exports = { validateCareDeploymentConfiguration };

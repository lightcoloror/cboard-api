'use strict';

const { createRuntime, policyFromEnvironment } = require('../helpers/careTrialRuntime');
const { validatePolicy } = require('../helpers/careTrialClaim');
const { createCareTrialRateLimitRuntime, consumeCareTrialLimits } = require('../helpers/careTrialRateLimit');

function createCareTrialController({ env = process.env, runtimeFactory = createRuntime, policyReader = policyFromEnvironment, limiters, limiterRuntimeFactory = createCareTrialRateLimitRuntime, consumeLimits = consumeCareTrialLimits } = {}) {
  let cachedLimiters = limiters;
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user || !req.user.id) return res.status(401).json({ code: 'LOGIN_REQUIRED' });
    if (env.CARE_NEXT_ENABLED !== 'true' || env.CARE_PUBLIC_TRIAL_ENABLED !== 'true') return res.status(503).json({ code: 'CARE_TRIAL_DISABLED' });
    const policy = validatePolicy(policyReader());
    if (!policy) return res.status(503).json({ code: 'TRIAL_NOT_CONFIGURED' });
    try {
      // Kept in this controller closure: it is still Mongo-backed, but a
      // request does not recreate rate-limiter indexes or connection setup.
      if (!cachedLimiters) cachedLimiters = limiterRuntimeFactory().limiters;
      await consumeLimits({ limiters: cachedLimiters, accountId: String(req.user.id), ip: req.ip });
      const result = await runtimeFactory({ policy }).claim(String(req.user.id), req.body && req.body.familyId);
      return res.status(200).json(result);
    } catch (error) {
      if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
      return res.status(error.status || 503).json({ code: error.code || 'CARE_TRIAL_UNAVAILABLE' });
    }
  };
}

exports.claimCareTrial = createCareTrialController();
exports.createCareTrialController = createCareTrialController;

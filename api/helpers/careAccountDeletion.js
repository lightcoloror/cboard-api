'use strict';

const { Family: CareFamily } = require('../models/CareWorkspace');

const FAMILY_TRANSFER_REQUIRED = 'FAMILY_TRANSFER_REQUIRED';
const CARE_FAMILY_CHECK_UNAVAILABLE = 'CARE_FAMILY_CHECK_UNAVAILABLE';

function createCareAccountDeletionGuard({ Family = CareFamily } = {}) {
  return async function getCareAccountDeletionBlocker(accountId) {
    let families;
    try {
      families = await Family.find({ owner: accountId })
        .select('_id')
        .sort({ _id: 1 })
        .lean()
        .exec();
    } catch (error) {
      return {
        status: 503,
        message: 'Unable to verify family administration before deleting account',
        error: { code: CARE_FAMILY_CHECK_UNAVAILABLE }
      };
    }

    if (!families.length) return null;

    return {
      status: 409,
      message: 'Transfer family administration before deleting this account',
      error: {
        code: FAMILY_TRANSFER_REQUIRED,
        requiredAction: 'transfer_administrator',
        families: families.map(family => ({ familyId: family._id }))
      }
    };
  };
}

module.exports = {
  CARE_FAMILY_CHECK_UNAVAILABLE,
  FAMILY_TRANSFER_REQUIRED,
  createCareAccountDeletionGuard,
  getCareAccountDeletionBlocker: createCareAccountDeletionGuard()
};

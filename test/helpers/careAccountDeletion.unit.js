'use strict';

const chai = require('chai');
const {
  CARE_FAMILY_CHECK_UNAVAILABLE,
  FAMILY_TRANSFER_REQUIRED,
  createCareAccountDeletionGuard
} = require('../../api/helpers/careAccountDeletion');

const expect = chai.expect;

function familyQuery(result, record) {
  return {
    select(value) {
      record.select = value;
      return this;
    },
    sort(value) {
      record.sort = value;
      return this;
    },
    lean() {
      record.lean = true;
      return this;
    },
    async exec() {
      if (result instanceof Error) throw result;
      return result;
    }
  };
}

describe('care account deletion guard', function() {
  it('blocks deletion with the stable transfer payload for every owned family', async function() {
    const record = {};
    const guard = createCareAccountDeletionGuard({
      Family: {
        find(filter) {
          record.filter = filter;
          return familyQuery([{ _id: 'family-a' }, { _id: 'family-b' }], record);
        }
      }
    });

    expect(await guard('user-1')).to.deep.equal({
      status: 409,
      message: 'Transfer family administration before deleting this account',
      error: {
        code: FAMILY_TRANSFER_REQUIRED,
        requiredAction: 'transfer_administrator',
        families: [{ familyId: 'family-a' }, { familyId: 'family-b' }]
      }
    });
    expect(record).to.deep.equal({
      filter: { owner: 'user-1' },
      select: '_id',
      sort: { _id: 1 },
      lean: true
    });
  });

  it('allows deletion only when no owned family exists', async function() {
    const guard = createCareAccountDeletionGuard({
      Family: { find() { return familyQuery([], {}); } }
    });

    expect(await guard('user-1')).to.equal(null);
  });

  it('fails closed when the family owner lookup is unavailable', async function() {
    const guard = createCareAccountDeletionGuard({
      Family: { find() { return familyQuery(new Error('storage unavailable'), {}); } }
    });

    expect(await guard('user-1')).to.deep.equal({
      status: 503,
      message: 'Unable to verify family administration before deleting account',
      error: { code: CARE_FAMILY_CHECK_UNAVAILABLE }
    });
  });
});

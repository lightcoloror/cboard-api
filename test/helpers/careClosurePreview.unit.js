'use strict';

const chai = require('chai');
const { createCareClosureCoordinator } = require('../../api/helpers/careClosureCoordinator');

const expect = chai.expect;

function matches(document, filter) {
  return Object.keys(filter).every(key => {
    const expected = filter[key];
    const actual = document[key];
    if (expected && expected.$in) return expected.$in.includes(actual);
    return actual === expected;
  });
}

function createConnection({ account, families = [], profiles = [], fundings = [], maxScanRecords } = {}) {
  const rows = {
    careaccountlifecycles: account ? [account] : [],
    carefamilies: families,
    careprofiles: profiles,
    carefundings: fundings,
    careaccounts: [],
    careclosurejobs: []
  };
  const reads = [];
  const writes = [];
  const collections = Object.fromEntries(Object.keys(rows).map(name => [name, {
    find(filter, options) {
      reads.push({ collection: name, method: 'find', filter, options });
      return {
        limit(value) {
          return {
            async toArray() {
              return rows[name].filter(row => matches(row, filter)).slice(0, value);
            }
          };
        }
      };
    },
    async findOne(filter, options) {
      reads.push({ collection: name, method: 'findOne', filter, options });
      return rows[name].find(row => matches(row, filter)) || null;
    },
    async insertOne() { writes.push({ collection: name, method: 'insertOne' }); },
    async updateOne() { writes.push({ collection: name, method: 'updateOne' }); },
    async deleteOne() { writes.push({ collection: name, method: 'deleteOne' }); }
  }]));
  const connection = {
    collection(name) {
      return collections[name];
    },
    async startSession() {
      const session = { id: 'preview-session' };
      session.withTransaction = async callback => callback(session);
      session.endSession = async () => {};
      return session;
    }
  };
  return { connection, reads, writes, maxScanRecords };
}

function createCoordinator(data = {}) {
  const fixture = createConnection(data);
  return {
    fixture,
    coordinator: createCareClosureCoordinator({
      connection: fixture.connection,
      encryption: { seal() { return 'sealed'; } },
      ...(data.maxScanRecords ? { maxScanRecords: data.maxScanRecords } : {})
    })
  };
}

async function expectFailure(promise, code) {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error.code).to.equal(code);
  }
}

describe('care closure preview', function() {
  it('refuses malformed historical family identifiers before presenting confirmation', async function() {
    const { coordinator, fixture } = createCoordinator({
      families: [{ _id: '../invalid', owner: 'owner-invalid' }]
    });
    await expectFailure(coordinator.preview('owner-invalid'), 'CLOSURE_SCOPE_MISMATCH');
    expect(fixture.writes).to.deep.equal([]);
  });
  it('reports institution, non-family funding, and member transfer blockers without writes', async function() {
    const owner = 'owner-preview';
    const { coordinator, fixture } = createCoordinator({
      account: { _id: owner, status: 'open' },
      families: [{ _id: 'family-1', owner, closure: { status: 'open' } }],
      profiles: [{ _id: 'profile-1', familyId: 'family-1', members: [owner, 'member-2'] }],
      fundings: [
        { _id: 'institution-1', owner, kind: 'institution' },
        { _id: 'other-1', owner, kind: 'personal', familyId: 'other-family' }
      ]
    });

    const result = await coordinator.preview(owner);

    expect(result.familyIds).to.deep.equal(['family-1']);
    expect(result.families).to.deep.equal([{
      familyId: 'family-1', profileCount: 1, requiresTransfer: true
    }]);
    expect(result.blockers).to.deep.include.members([
      { code: 'FAMILY_TRANSFER_REQUIRED', familyIds: ['family-1'] },
      { code: 'INSTITUTION_TRANSFER_REQUIRED', fundingIds: ['institution-1'] },
      { code: 'FUNDING_TRANSFER_REQUIRED', fundingIds: ['other-1'] }
    ]);
    expect(result.canConfirm).to.equal(false);
    expect(result.deletesCloudData).to.equal(true);
    expect(result.preservesLocalData).to.equal(true);
    expect(fixture.writes).to.deep.equal([]);
  });

  it('uses a transaction session for every read and remains a read-only confirmation', async function() {
    const { coordinator, fixture } = createCoordinator({
      account: { _id: 'owner-readonly', status: 'open' },
      families: [{ _id: 'family-readonly', owner: 'owner-readonly', closure: { status: 'open' } }],
      profiles: [],
      fundings: []
    });

    const result = await coordinator.preview('owner-readonly');

    expect(result.canConfirm).to.equal(true);
    expect(result.confirmationRequired).to.equal(true);
    expect(result.revalidationRequired).to.equal(true);
    expect(result.accountDeleted).to.equal(undefined);
    expect(fixture.reads).to.have.length.greaterThan(0);
    expect(fixture.reads.every(read => read.options.session.id === 'preview-session')).to.equal(true);
    expect(fixture.writes).to.deep.equal([]);
  });

  it('fails closed when the owned-family scan exceeds its bound', async function() {
    const { coordinator, fixture } = createCoordinator({
      maxScanRecords: 1,
      account: { _id: 'owner-limit', status: 'open' },
      families: [
        { _id: 'family-a', owner: 'owner-limit', closure: { status: 'open' } },
        { _id: 'family-b', owner: 'owner-limit', closure: { status: 'open' } }
      ]
    });

    await expectFailure(coordinator.preview('owner-limit'), 'CLOSURE_SCAN_LIMIT_REACHED');
    expect(fixture.writes).to.deep.equal([]);
  });

  it('rejects a closed account before exposing family or funding details', async function() {
    const { coordinator, fixture } = createCoordinator({
      account: { _id: 'owner-closed', status: 'closed' },
      families: [{ _id: 'private-family', owner: 'owner-closed' }],
      fundings: [{ _id: 'private-funding', owner: 'owner-closed', kind: 'family' }]
    });

    await expectFailure(coordinator.preview('owner-closed'), 'ACCOUNT_CLOSED');
    expect(fixture.reads.map(read => read.collection)).to.deep.equal([
      'careaccountlifecycles'
    ]);
    expect(fixture.writes).to.deep.equal([]);
  });
});

'use strict';

const chai = require('chai');
const Settings = require('../../api/models/Settings');

const expect = chai.expect;

describe('Settings model atomic initialization', function() {
  let originalFindOneAndUpdate;

  beforeEach(function() {
    originalFindOneAndUpdate = Settings.findOneAndUpdate;
  });

  afterEach(function() {
    Settings.findOneAndUpdate = originalFindOneAndUpdate;
  });

  it('atomically upserts one settings document for the authenticated user', async function() {
    let captured;
    Settings.findOneAndUpdate = (filter, update, options) => {
      captured = { filter, update, options };
      return {
        exec: async () => ({
          toJSON: () => ({ id: 'settings-1', user: 'user-1' })
        })
      };
    };

    const result = await Settings.getOrCreate({ id: 'user-1' });

    expect(captured).to.deep.equal({
      filter: { user: 'user-1' },
      update: { $setOnInsert: { user: 'user-1' } },
      options: {
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        upsert: true
      }
    });
    expect(result).to.deep.equal({ id: 'settings-1', user: 'user-1' });
  });

  it('requires an authenticated user id', async function() {
    let error;
    try {
      await Settings.getOrCreate({});
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.an('error');
    expect(error.message).to.equal('A user id is required to load settings');
  });
});

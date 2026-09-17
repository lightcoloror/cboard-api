'use strict';

const chai = require('chai');
const mockery = require('mockery');
const User = require('../../api/models/User');

const expect = chai.expect;

function profile(email = 'oauth@example.test') {
  return {
    id: 'provider-id',
    accessToken: 'provider-token',
    displayName: 'OAuth User',
    name: { givenName: 'OAuth', familyName: 'User' },
    emails: [{ value: email }],
    photos: [{ value: 'https://example.test/avatar.png' }]
  };
}

async function expectRejected(promise, message) {
  let error;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).to.be.an('error');
  expect(error.message).to.include(message);
}

describe('User OAuth existing-user lifecycle writes', function() {
  let originalFindOne;
  let previousFlag;

  beforeEach(function() {
    previousFlag = process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    originalFindOne = User.findOne;
    mockery.enable({ warnOnReplace: false, warnOnUnregistered: false, useCleanCache: true });
  });

  afterEach(function() {
    User.findOne = originalFindOne;
    if (previousFlag === undefined) delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    else process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = previousFlag;
    mockery.deregisterAll();
    mockery.disable();
  });

  function installLifecycle({ currentUser, lifecycleError, commitError } = {}) {
    const session = { id: 'oauth-session' };
    let callbackCalled = false;
    let lifecycleOwner;
    mockery.registerMock('../helpers/careFamilyLifecycle', {
      createCareFamilyLifecycle() {
        return {
          async withOpenAccount(owner, callback) {
            lifecycleOwner = owner;
            if (lifecycleError) throw lifecycleError;
            callbackCalled = true;
            const result = await callback(session);
            if (commitError) throw commitError;
            return result;
          }
        };
      }
    });

    let query;
    User.findOne = filter => {
      query = {
        filter,
        sessionValue: null,
        session(value) { this.sessionValue = value; return this; },
        exec() { return Promise.resolve(currentUser); }
      };
      return query;
    };
    return {
      session,
      get callbackCalled() { return callbackCalled; },
      get lifecycleOwner() { return lifecycleOwner; },
      get query() { return query; }
    };
  }

  for (const provider of ['Facebook', 'Google', 'Apple']) {
    it(`updates an existing ${provider} user inside the account transaction`, async function() {
      process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
      let oldSaveCalls = 0;
      let savedOptions;
      const existingUser = {
        _id: 'user-123', email: 'old@example.test', role: 'user', password: 'preserve',
        save() { oldSaveCalls += 1; throw new Error('must not save stale document'); }
      };
      const currentUser = {
        _id: 'user-123', email: 'old@example.test', role: 'user', password: 'preserve',
        save(options) { savedOptions = options; return Promise.resolve(this); }
      };
      const state = installLifecycle({ currentUser });

      const result = await User[`updateUserFrom${provider}`](profile(), existingUser);

      expect(result).to.equal(currentUser);
      expect(state.callbackCalled).to.equal(true);
      expect(state.lifecycleOwner).to.equal('user-123');
      expect(state.query.filter).to.deep.equal({ _id: 'user-123', email: 'old@example.test' });
      expect(state.query.sessionValue).to.equal(state.session);
      expect(savedOptions).to.deep.equal({ session: state.session });
      expect(currentUser[provider.toLowerCase()]).to.include({ id: 'provider-id', token: 'provider-token' });
      expect(currentUser.email).to.equal('old@example.test');
      expect(currentUser.role).to.equal('user');
      expect(currentUser.password).to.equal('preserve');
      expect(oldSaveCalls).to.equal(0);
      expect(existingUser.facebook).to.equal(undefined);
      expect(existingUser.google).to.equal(undefined);
      expect(existingUser.apple).to.equal(undefined);
    });
  }

  it('keeps the legacy direct save when lifecycle transactions are disabled', async function() {
    delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    let saved = 0;
    const existingUser = {
      _id: 'user-123', email: 'old@example.test',
      save() { saved += 1; return Promise.resolve(this); }
    };

    const result = await User.updateUserFromGoogle(profile(), existingUser);

    expect(result).to.equal(existingUser);
    expect(saved).to.equal(1);
    expect(existingUser.google.id).to.equal('provider-id');
  });

  it('does not read or write when the account is closing or closed', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    let findCalls = 0;
    const closing = new Error('ACCOUNT_CLOSING');
    closing.status = 409;
    const state = installLifecycle({ lifecycleError: closing });
    User.findOne = () => { findCalls += 1; throw new Error('must not query after lifecycle rejection'); };

    await expectRejected(
      User.updateUserFromFacebook(profile(), { _id: 'user-123', email: 'old@example.test' }),
      'ACCOUNT_CLOSING'
    );
    expect(findCalls).to.equal(0);
    expect(state.callbackCalled).to.equal(false);
  });

  it('rejects a missing or email-mismatched current user before saving', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    const state = installLifecycle({ currentUser: null });
    await expectRejected(
      User.updateUserFromApple(profile(), { _id: 'user-123', email: 'old@example.test' }),
      'OAuth user is no longer available'
    );
    expect(state.query.filter).to.deep.equal({ _id: 'user-123', email: 'old@example.test' });
  });

  it('does not publish a save when the transaction commit fails', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    let saveCalls = 0;
    const currentUser = {
      _id: 'user-123', email: 'old@example.test',
      save() { saveCalls += 1; return Promise.resolve(this); }
    };
    const commitError = new Error('commit failed');
    installLifecycle({ currentUser, commitError });

    await expectRejected(User.updateUserFromFacebook(profile(), {
      _id: 'user-123', email: 'old@example.test'
    }), 'commit failed');
    expect(saveCalls).to.equal(1);
  });
});

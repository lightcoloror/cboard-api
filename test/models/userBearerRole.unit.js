'use strict';

const chai = require('chai');
const User = require('../../api/models/User');

const expect = chai.expect;

describe('User bearer role lifecycle boundary', function() {
  it('preserves transaction errors rather than swallowing retry labels', async function() {
    const failure = Object.assign(new Error('write conflict'), { errorLabels: ['TransientTransactionError'] });
    try {
      await User.updateUser({ save: async () => { throw failure; } }, { session: {} });
      expect.fail('expected transaction error');
    } catch (error) { expect(error).to.equal(failure); }
  });
  let originalFindOne;
  let originalUpdateUser;

  beforeEach(function() {
    originalFindOne = User.findOne;
    originalUpdateUser = User.updateUser;
  });

  afterEach(function() {
    User.findOne = originalFindOne;
    User.updateUser = originalUpdateUser;
  });

  it('re-reads and saves a missing role in the account transaction session', async function() {
    const session = { id: 'role-session' };
    const current = { _id: 'user-1', email: 'user@example.test', role: undefined };
    let queryFilter;
    let querySession;
    let savedOptions;
    User.findOne = filter => {
      queryFilter = filter;
      return {
        session(value) { querySession = value; return this; },
        exec() { return Promise.resolve(current); }
      };
    };
    User.updateUser = async (value, options) => {
      savedOptions = options;
      return value;
    };
    let lifecycleOwner;
    const lifecycle = {
      async withOpenAccount(owner, callback) {
        lifecycleOwner = owner;
        return callback(session);
      }
    };

    const result = await User.ensureBearerRole({ id: 'user-1', role: undefined }, {
      lifecycleEnabled: () => true,
      lifecycle
    });

    expect(result).to.equal(current);
    expect(lifecycleOwner).to.equal('user-1');
    expect(queryFilter).to.deep.equal({ _id: 'user-1' });
    expect(querySession).to.equal(session);
    expect(savedOptions).to.deep.equal({ session });
    expect(current.role).to.equal('user');
  });

  it('does not overwrite a role changed by a concurrent actor', async function() {
    const current = { _id: 'user-2', email: 'admin@example.test', role: 'admin' };
    let saveCalls = 0;
    User.findOne = () => ({ exec: () => Promise.resolve(current) });
    User.updateUser = async () => { saveCalls += 1; return current; };

    const result = await User.ensureBearerRole({ id: 'user-2' }, {
      lifecycleEnabled: () => false
    });

    expect(result).to.equal(current);
    expect(result.role).to.equal('admin');
    expect(saveCalls).to.equal(0);
  });

  it('does not read or save after the lifecycle rejects a closing account', async function() {
    let findCalls = 0;
    User.findOne = () => {
      findCalls += 1;
      throw new Error('must not read after lifecycle rejection');
    };
    const closing = new Error('closing');
    closing.code = 'ACCOUNT_CLOSING';
    closing.status = 409;
    const lifecycle = {
      async withOpenAccount() { throw closing; }
    };

    let caught;
    try {
      await User.ensureBearerRole({ id: 'user-3' }, {
        lifecycleEnabled: () => true,
        lifecycle
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).to.equal(closing);
    expect(findCalls).to.equal(0);
  });

  it('returns the saved document and passes save options without calling exec', async function() {
    const saved = { _id: 'user-4', role: 'user' };
    let received;
    const document = {
      save(options) {
        received = options;
        return Promise.resolve(saved);
      }
    };

    const result = await User.updateUser(document, { session: { id: 'save-session' } });

    expect(result).to.equal(saved);
    expect(received).to.deep.equal({ session: { id: 'save-session' } });
  });
});

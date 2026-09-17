'use strict';

const chai = require('chai');
const bcrypt = require('bcryptjs');
const User = require('../../api/models/User');

const expect = chai.expect;

function fakeModel(users, queries) {
  return {
    findOne(query) {
      queries.push(query);
      const chain = {
        populate() {
          return chain;
        },
        exec() {
          return Promise.resolve(
            users.find(user => user.email === query.email) || null
          );
        }
      };
      return chain;
    }
  };
}

function authenticate(model, email, password) {
  return new Promise(resolve => {
    User.authenticate.call(model, email, password, (error, user) =>
      resolve({ error, user })
    );
  });
}

describe('User.authenticate email normalization', function() {
  it('finds a new canonical account after trimming and normalizing input', async function() {
    const queries = [];
    const user = {
      email: 'new@example.test',
      password: bcrypt.hashSync('secret', 4)
    };
    const result = await authenticate(
      fakeModel([user], queries),
      '  NEW@EXAMPLE.TEST ',
      'secret'
    );

    expect(result.error).to.equal(null);
    expect(result.user).to.equal(user);
    expect(queries).to.deep.equal([
      { email: 'NEW@EXAMPLE.TEST' },
      { email: 'new@example.test' }
    ]);
  });

  it('preserves exact-case legacy account lookup', async function() {
    const queries = [];
    const user = {
      email: 'Legacy@Example.test',
      password: bcrypt.hashSync('secret', 4)
    };
    const result = await authenticate(
      fakeModel([user], queries),
      '  Legacy@Example.test ',
      'secret'
    );

    expect(result.error).to.equal(null);
    expect(result.user).to.equal(user);
    expect(queries).to.deep.equal([{ email: 'Legacy@Example.test' }]);
  });

  it('does not fall back after an exact-case account fails password verification', async function() {
    const queries = [];
    const exactUser = {
      email: 'Case@Example.test',
      password: bcrypt.hashSync('exact-secret', 4)
    };
    const canonicalUser = {
      email: 'case@example.test',
      password: bcrypt.hashSync('canonical-secret', 4)
    };
    const result = await authenticate(
      fakeModel([exactUser, canonicalUser], queries),
      'Case@Example.test',
      'canonical-secret'
    );

    expect(result.error).to.equal(undefined);
    expect(result.user).to.equal(undefined);
    expect(queries).to.deep.equal([{ email: 'Case@Example.test' }]);
  });

  it('rejects non-string credentials without querying the backing model', async function() {
    const queries = [];
    const model = fakeModel([], queries);
    const emailResult = await authenticate(model, { $gt: '' }, 'secret');
    const passwordResult = await authenticate(model, 'user@example.test', {
      $ne: ''
    });

    expect(emailResult.error).to.be.instanceOf(Error);
    expect(passwordResult.error).to.be.instanceOf(Error);
    expect(queries).to.deep.equal([]);
  });

  it('rejects blank credentials without querying the backing model', async function() {
    const queries = [];
    const model = fakeModel([], queries);
    const blankEmail = await authenticate(model, '  ', 'secret');
    const blankPassword = await authenticate(model, 'user@example.test', '');

    expect(blankEmail.error).to.be.instanceOf(Error);
    expect(blankPassword.error).to.be.instanceOf(Error);
    expect(queries).to.deep.equal([]);
  });
});

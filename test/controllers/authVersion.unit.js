'use strict';

const chai = require('chai');
const auth = require('../../api/helpers/auth');

const expect = chai.expect;

describe('authentication version', function() {
  it('embeds a bounded version in newly issued tokens', function() {
    const value = auth.getTokenData(
      auth.issueToken({
        id: 'user-id',
        email: 'care@example.test',
        authVersion: 3
      })
    );

    expect(value).to.include({
      id: 'user-id',
      email: 'care@example.test',
      authVersion: 3
    });
  });

  it('keeps legacy version-zero tokens compatible and rejects stale versions', function() {
    expect(auth.isTokenCurrentForUser({}, { authVersion: 0 })).to.equal(true);
    expect(
      auth.isTokenCurrentForUser({ authVersion: 0 }, { authVersion: 1 })
    ).to.equal(false);
    expect(
      auth.isTokenCurrentForUser({ authVersion: 2 }, { authVersion: 2 })
    ).to.equal(true);
  });
});

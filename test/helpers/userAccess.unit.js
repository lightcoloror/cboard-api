'use strict';

const chai = require('chai');
const access = require('../../api/helpers/userAccess');

const expect = chai.expect;

describe('user access authorization helper', function() {
  const expectFailure = (result, status, code) => {
    expect(result).to.deep.equal({
      ok: false,
      status,
      body: {
        message: 'You are not authorized to access this user.',
        error: { code }
      }
    });
  };
  const unauthorized = result =>
    expectFailure(result, 401, 'USER_ACCESS_UNAUTHORIZED');
  const forbidden = result =>
    expectFailure(result, 403, 'USER_ACCESS_FORBIDDEN');

  it('accepts a resolved user identity and matching optional auth identity', function() {
    const result = access.authenticated({
      user: { _id: { toString: () => 'user-1' }, role: 'user' },
      auth: { id: 'user-1' }
    });
    expect(result.ok).to.equal(true);
    expect(result.id).to.equal('user-1');
  });

  it('rejects anonymous requests and auth identity mismatches', function() {
    unauthorized(access.authenticated({}));
    unauthorized(
      access.authenticated({ user: { id: 'user-1', role: 'user' }, auth: { id: 'user-2' } })
    );
    unauthorized(
      access.authenticated({ user: { id: 'user-1', role: 'user' }, auth: { id: '' } })
    );
  });

  it('requires the resolved user role to be exactly admin for list/delete access', function() {
    expect(access.requireAdmin({ user: { id: 'admin-1', role: 'admin' } }).ok).to.equal(true);
    forbidden(access.requireAdmin({ user: { id: 'user-1', role: 'user', isAdmin: true } }));
    forbidden(access.requireAdmin({ user: { id: 'user-1', role: 'household-admin', isAdmin: true } }));
    forbidden(access.requireAdmin({ user: { id: 'user-1', role: 'user' }, body: { role: 'admin' } }));
  });

  it('allows only self or platform admin for get/update access', function() {
    expect(access.requireSelfOrAdmin({ user: { id: 'user-1', role: 'user' } }, 'user-1').ok).to.equal(true);
    expect(access.requireSelfOrAdmin({ user: { id: 'admin-1', role: 'admin' } }, 'user-2').ok).to.equal(true);
    forbidden(access.requireSelfOrAdmin({ user: { id: 'user-1', role: 'user' } }, 'user-2'));
    forbidden(access.requireSelfOrAdmin({ user: { id: 'user-1', role: 'household-admin' } }, 'user-2'));
  });

  it('compares object id values by their stable string form', function() {
    expect(
      access.requireSelfOrAdmin(
        { user: { _id: { toString: () => '507f1f77bcf86cd799439011' }, role: 'user' } },
        { toString: () => '507f1f77bcf86cd799439011' }
      ).ok
    ).to.equal(true);
  });
});

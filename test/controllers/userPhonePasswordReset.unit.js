'use strict';

const bcrypt = require('bcryptjs');
const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('user phone password reset controller', function() {
  let controller;
  let user;
  let verificationError;
  let lookupError;
  let updateError;
  let resetUpdateError;
  let consumed;
  let userUpdate;
  let invalidatedEmailReset;

  beforeEach(function() {
    verificationError = null;
    lookupError = null;
    updateError = null;
    resetUpdateError = null;
    consumed = null;
    userUpdate = null;
    invalidatedEmailReset = null;
    user = {
      _id: 'user-id',
      email: 'care@example.test',
      phone: '13800138000',
      role: 'user'
    };

    const User = {
      findOne(query) {
        return {
          async exec() {
            if (lookupError) throw lookupError;
            return query.phone === '13800138000' ? user : null;
          }
        };
      },
      findOneAndUpdate(filter, update, options) {
        userUpdate = { filter, update, options };
        return {
          async exec() {
            if (updateError) throw updateError;
            return filter._id === 'user-id' && user.role !== 'admin'
              ? user
              : null;
          }
        };
      }
    };

    const ResetPassword = {
      updateMany(filter, update) {
        invalidatedEmailReset = { filter, update };
        return {
          async exec() {
            if (resetUpdateError) throw resetUpdateError;
            return { modifiedCount: 1 };
          }
        };
      }
    };

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('../models/User', User);
    mockery.registerMock('../models/ResetPassword', ResetPassword);
    mockery.registerMock('../models/Settings', {});
    mockery.registerMock('../models/Subscribers', {});
    mockery.registerMock('../mail', { nev: { options: {} } });
    mockery.registerMock('../helpers/auth', {});
    mockery.registerMock('../helpers/phoneVerificationRuntime', {
      phoneVerificationService: {
        async consumePasswordResetVerification(value) {
          consumed = value;
          if (verificationError) throw verificationError;
          return { verified: true };
        }
      }
    });
    mockery.registerMock('../helpers/localize', {
      async findIpLocation() {
        return null;
      },
      isLocalIp() {
        return true;
      }
    });
    controller = require('../../api/controllers/user');
  });

  afterEach(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  function response() {
    return {
      statusCode: 0,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      }
    };
  }

  function request(overrides = {}) {
    return {
      body: {
        phone: '13800138000',
        phoneVerificationToken: 'a'.repeat(64),
        password: 'new-password',
        ...overrides
      }
    };
  }

  it('consumes a password-reset token, hashes the password and revokes old authentication', async function() {
    const res = response();
    await controller.resetPasswordWithPhone(request(), res);

    expect(consumed).to.deep.equal({
      phone: '13800138000',
      token: 'a'.repeat(64)
    });
    expect(res.statusCode).to.equal(200);
    expect(res.body).to.deep.equal({
      success: 1,
      message: 'Password reset. Please sign in again.'
    });
    expect(userUpdate.filter).to.deep.equal({
      _id: 'user-id',
      role: { $ne: 'admin' }
    });
    expect(userUpdate.update.$inc).to.deep.equal({ authVersion: 1 });
    expect(
      await bcrypt.compare('new-password', userUpdate.update.$set.password)
    ).to.equal(true);
    expect(invalidatedEmailReset).to.deep.equal({
      filter: { userId: 'user-id', status: false },
      update: { $set: { status: true } }
    });
    expect(res.body).not.to.have.property('authToken');
  });

  it('rejects weak input before consuming the verification token', async function() {
    const res = response();
    await controller.resetPasswordWithPhone(request({ password: '123' }), res);

    expect(res.statusCode).to.equal(400);
    expect(consumed).to.equal(null);
    expect(userUpdate).to.equal(null);
  });

  it('uses one bounded failure for unverified, unknown and administrator accounts', async function() {
    verificationError = Object.assign(new Error('private provider detail'), {
      status: 403,
      code: 'PHONE_VERIFICATION_REQUIRED'
    });
    const unverified = response();
    await controller.resetPasswordWithPhone(request(), unverified);

    verificationError = null;
    const unknown = response();
    await controller.resetPasswordWithPhone(
      request({ phone: '13900139000' }),
      unknown
    );

    user.role = 'admin';
    const administrator = response();
    await controller.resetPasswordWithPhone(request(), administrator);

    [unverified, unknown, administrator].forEach(res => {
      expect(res.statusCode).to.equal(400);
      expect(res.body).to.deep.equal({
        message: 'Unable to reset the password.',
        error: { code: 'PASSWORD_RESET_FAILED' }
      });
      expect(JSON.stringify(res.body)).not.to.contain('private');
    });
  });

  it('fails closed without exposing storage details', async function() {
    updateError = new Error('mongo connection secret');
    const res = response();
    await controller.resetPasswordWithPhone(request(), res);

    expect(res.statusCode).to.equal(500);
    expect(JSON.stringify(res.body)).not.to.contain('mongo');
    expect(JSON.stringify(res.body)).not.to.contain('secret');
  });

  it('does not change the password when old email reset tokens cannot be revoked', async function() {
    resetUpdateError = new Error('reset storage unavailable');
    const res = response();
    await controller.resetPasswordWithPhone(request(), res);

    expect(res.statusCode).to.equal(500);
    expect(userUpdate).to.equal(null);
    expect(JSON.stringify(res.body)).not.to.contain('storage');
  });
});

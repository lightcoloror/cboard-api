'use strict';

const bcrypt = require('bcryptjs');
const chai = require('chai');
const mockery = require('mockery');
const {
  compareResetToken,
  hashResetToken
} = require('../../api/helpers/passwordReset');

const expect = chai.expect;

describe('legacy email password reset controller security', function() {
  let controller;
  let emailUser;
  let resetRecord;
  let resetUpsert;
  let consumedReset;
  let userUpdate;
  let sentEmail;

  beforeEach(function() {
    emailUser = {
      _id: 'user-id',
      id: 'user-id',
      email: 'care@example.test',
      role: 'user'
    };
    resetRecord = null;
    resetUpsert = null;
    consumedReset = null;
    userUpdate = null;
    sentEmail = null;

    const User = {
      findOne(query) {
        return {
          async exec() {
            return query.email === 'care@example.test' ? emailUser : null;
          }
        };
      },
      findOneAndUpdate(filter, update, options) {
        userUpdate = { filter, update, options };
        return {
          async exec() {
            return filter._id === 'user-id' ? emailUser : null;
          }
        };
      }
    };

    const ResetPassword = {
      findOne(query) {
        return {
          async exec() {
            if (
              !resetRecord ||
              query.userId !== resetRecord.userId ||
              query.status !== false
            ) {
              return null;
            }
            return resetRecord.resetPasswordExpires > new Date()
              ? resetRecord
              : null;
          }
        };
      },
      findOneAndUpdate(filter, update, options) {
        if (options && options.upsert) {
          resetUpsert = { filter, update, options };
          return {
            async exec() {
              return { _id: 'reset-id' };
            }
          };
        }
        consumedReset = { filter, update, options };
        return {
          async exec() {
            return resetRecord && !resetRecord.consumed
              ? { ...resetRecord, status: true }
              : null;
          }
        };
      },
      updateMany() {
        return { async exec() {} };
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
    mockery.registerMock('../mail', {
      nev: {
        options: {},
        sendResetPasswordEmail(email, domain, userId, token, callback) {
          sentEmail = { email, domain, userId, token };
          callback(null);
        }
      }
    });
    mockery.registerMock('../helpers/auth', {});
    mockery.registerMock('../helpers/phoneVerificationRuntime', {
      phoneVerificationService: {}
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

  it('returns the same generic response and never exposes a raw reset token', async function() {
    const known = response();
    await controller.forgotPassword(
      {
        body: { email: 'care@example.test' },
        headers: { origin: 'http://localhost:3000' }
      },
      known
    );
    const unknown = response();
    await controller.forgotPassword(
      {
        body: { email: 'unknown@example.test' },
        headers: { origin: 'http://localhost:3000' }
      },
      unknown
    );

    expect(known.statusCode).to.equal(200);
    expect(unknown.statusCode).to.equal(200);
    expect(unknown.body).to.deep.equal(known.body);
    expect(known.body).to.deep.equal({
      success: 1,
      message:
        'If the account exists, password reset instructions will be sent shortly.'
    });
    expect(known.body).not.to.have.property('url');
    expect(known.body).not.to.have.property('userid');
    expect(sentEmail.token).to.match(/^[a-f0-9]{64}$/);
    expect(
      await compareResetToken(
        sentEmail.token,
        resetUpsert.update.$set.resetPasswordToken
      )
    ).to.equal(true);
  });

  it('checks expiry and token before atomically consuming and updating the password', async function() {
    const token = 'd'.repeat(64);
    resetRecord = {
      _id: 'reset-id',
      userId: 'user-id',
      resetPasswordToken: await hashResetToken(token),
      resetPasswordExpires: new Date(Date.now() + 60000),
      status: false
    };
    const res = response();
    await controller.storePassword(
      {
        body: {
          userid: 'user-id',
          token,
          password: 'new-password'
        }
      },
      res
    );

    expect(res.statusCode).to.equal(200);
    expect(consumedReset.filter).to.include({
      _id: 'reset-id',
      status: false
    });
    expect(userUpdate.update.$inc).to.deep.equal({ authVersion: 1 });
    expect(
      await bcrypt.compare('new-password', userUpdate.update.$set.password)
    ).to.equal(true);
    expect(res.body).not.to.have.property('url');
  });

  it('rejects an invalid or expired token without changing the user', async function() {
    resetRecord = {
      _id: 'reset-id',
      userId: 'user-id',
      resetPasswordToken: await hashResetToken('e'.repeat(64)),
      resetPasswordExpires: new Date(Date.now() + 60000),
      status: false
    };
    const invalid = response();
    await controller.storePassword(
      {
        body: {
          userid: 'user-id',
          token: 'f'.repeat(64),
          password: 'new-password'
        }
      },
      invalid
    );

    expect(invalid.statusCode).to.equal(400);
    expect(userUpdate).to.equal(null);

    resetRecord.resetPasswordExpires = new Date(Date.now() - 1000);
    const expired = response();
    await controller.storePassword(
      {
        body: {
          userid: 'user-id',
          token: 'e'.repeat(64),
          password: 'new-password'
        }
      },
      expired
    );
    expect(expired.statusCode).to.equal(400);
    expect(userUpdate).to.equal(null);
  });
});

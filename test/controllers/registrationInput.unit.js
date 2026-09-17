'use strict';

const chai = require('chai');
const User = require('../../api/models/User');
const buildRegistrationUserData = require('../../api/helpers/registrationInput');

const expect = chai.expect;

describe('registration input boundary', function() {
  it('drops identity, role, OAuth, reset-token, timestamp and caller-location fields', function() {
    const untrusted = {
      _id: '507f1f77bcf86cd799439011',
      id: 'foreign-id',
      __proto__: { polluted: true },
      name: 'Caregiver',
      email: ' Attacker@Example.COM ',
      password: 'secret',
      role: 'admin',
      isAdmin: true,
      provider: 'google',
      authVersion: 99,
      isFirstLogin: false,
      google: { id: 'oauth-id', token: 'oauth-token' },
      facebook: { id: 'facebook-id', token: 'facebook-token' },
      apple: { id: 'apple-id', token: 'apple-token' },
      resetPasswordToken: 'reset-token',
      resetPasswordExpires: '2099-01-01',
      createdAt: '2099-01-01',
      updatedAt: '2099-01-01',
      location: { city: 'caller-city' }
    };

    const data = buildRegistrationUserData(untrusted, {
      city: 'server-city',
      country: 'server-country'
    });
    const user = new User(data);

    expect(user._id.toString()).not.to.equal('507f1f77bcf86cd799439011');
    expect(user.id).not.to.equal('foreign-id');
    expect(user.role).to.equal('user');
    expect(user.isAdmin).to.equal(false);
    expect(user.provider).to.equal('');
    expect(user.authVersion).to.equal(0);
    expect(user.isFirstLogin).to.equal(true);
    expect(user.google.id).to.equal(undefined);
    expect(user.facebook.id).to.equal(undefined);
    expect(user.apple.id).to.equal(undefined);
    expect(user.resetPasswordToken).to.equal(undefined);
    expect(data).not.to.have.property('createdAt');
    expect(data).not.to.have.property('updatedAt');
    expect(user.createdAt).to.equal(undefined);
    expect(user.updatedAt).to.equal(undefined);
    expect(user.location).to.include({
      city: 'server-city',
      country: 'server-country'
    });
    expect(user.location.city).not.to.equal('caller-city');
  });

  it('preserves legitimate registration values and model defaults', function() {
    const data = buildRegistrationUserData(
      {
        name: '  Local User  ',
        email: ' Local@Example.COM ',
        password: 'secret',
        phone: '138 0013 8000',
        birthdate: '2001-10-17',
        locale: ' zh-CN '
      },
      { countryCode: 'CN' }
    );
    const user = new User(data);

    expect(user.name).to.equal('  Local User  ');
    expect(user.email).to.equal('local@example.com');
    expect(user.password).to.equal('secret');
    expect(user.phone).to.equal('13800138000');
    expect(user.birthdate).to.deep.equal(new Date('2001-10-17'));
    expect(user.locale).to.equal('zh-CN');
    expect(user.location.countryCode).to.equal('CN');
  });

  it('omits absent optional fields so User defaults still apply', function() {
    const user = new User(
      buildRegistrationUserData({
        name: 'Default User',
        email: 'default@example.test',
        password: 'secret'
      })
    );

    expect(user.phone).to.equal(undefined);
    expect(user.birthdate).to.be.instanceOf(Date);
    expect(user.locale).to.equal('en-US');
    expect(user.lastlogin).to.be.instanceOf(Date);
  });
});

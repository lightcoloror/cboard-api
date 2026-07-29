'use strict';

const bcrypt = require('bcryptjs');
const chai = require('chai');

const {
  compareResetToken,
  hashNewPassword,
  hashResetToken,
  normalizeNewPassword,
  normalizeResetToken
} = require('../../api/helpers/passwordReset');

const expect = chai.expect;

describe('password reset helpers', function() {
  it('accepts only the existing bounded password policy', function() {
    expect(normalizeNewPassword('12345')).to.equal('');
    expect(normalizeNewPassword('123456')).to.equal('123456');
    expect(normalizeNewPassword('a'.repeat(128))).to.equal('a'.repeat(128));
    expect(normalizeNewPassword('a'.repeat(129))).to.equal('');
  });

  it('normalizes only opaque 64-character reset tokens', function() {
    expect(normalizeResetToken('A'.repeat(64))).to.equal('a'.repeat(64));
    expect(normalizeResetToken('short')).to.equal('');
    expect(normalizeResetToken('g'.repeat(64))).to.equal('');
  });

  it('hashes passwords and compares reset tokens without storing clear values', async function() {
    const passwordHash = await hashNewPassword('new-password');
    const token = 'b'.repeat(64);
    const tokenHash = await hashResetToken(token);

    expect(passwordHash).not.to.equal('new-password');
    expect(await bcrypt.compare('new-password', passwordHash)).to.equal(true);
    expect(tokenHash).not.to.equal(token);
    expect(await compareResetToken(token, tokenHash)).to.equal(true);
    expect(await compareResetToken('c'.repeat(64), tokenHash)).to.equal(false);
    expect(await compareResetToken('short', tokenHash)).to.equal(false);
  });
});

'use strict';

const bcrypt = require('bcryptjs');

const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 128;
const OPAQUE_RESET_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function normalizeNewPassword(value) {
  if (typeof value !== 'string') return '';
  if (
    value.length < MIN_PASSWORD_LENGTH ||
    value.length > MAX_PASSWORD_LENGTH
  ) {
    return '';
  }
  return value;
}

function normalizeResetToken(value) {
  const token = String(value || '')
    .trim()
    .toLowerCase();
  return OPAQUE_RESET_TOKEN_PATTERN.test(token) ? token : '';
}

function hashWithBcrypt(value) {
  return new Promise((resolve, reject) => {
    bcrypt.genSalt(8, (saltError, salt) => {
      if (saltError) return reject(saltError);
      return bcrypt.hash(value, salt, (hashError, hash) => {
        if (hashError) return reject(hashError);
        return resolve(hash);
      });
    });
  });
}

async function hashNewPassword(value) {
  const password = normalizeNewPassword(value);
  if (!password) {
    const error = new Error(
      `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`
    );
    error.code = 'PASSWORD_RESET_INVALID_PASSWORD';
    error.status = 400;
    throw error;
  }
  return hashWithBcrypt(password);
}

async function hashResetToken(value) {
  const token = normalizeResetToken(value);
  if (!token) {
    const error = new Error('Password reset token is invalid or expired.');
    error.code = 'PASSWORD_RESET_INVALID_TOKEN';
    error.status = 400;
    throw error;
  }
  return hashWithBcrypt(token);
}

async function compareResetToken(value, storedHash) {
  const token = normalizeResetToken(value);
  const hash = String(storedHash || '');
  if (!token || !hash) return false;
  try {
    return await bcrypt.compare(token, hash);
  } catch (error) {
    return false;
  }
}

module.exports = {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  OPAQUE_RESET_TOKEN_PATTERN,
  compareResetToken,
  hashNewPassword,
  hashResetToken,
  normalizeNewPassword,
  normalizeResetToken
};

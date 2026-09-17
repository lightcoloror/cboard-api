'use strict';

const { normalizeMainlandChinaPhone } = require('./userPhone');

function normalizedEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Build the only data allowed to enter a local, password-based registration.
 *
 * The location argument is intentionally separate from the request input. It
 * must be produced by the server (for example, from the request IP) before
 * calling this helper; `input.location` is never read.
 */
function buildRegistrationUserData(input, serverLocation) {
  const source = input && typeof input === 'object' ? input : {};
  const data = {
    name: source.name,
    email: normalizedEmail(source.email),
    password: source.password,
    role: 'user',
    provider: '',
    authVersion: 0,
    isFirstLogin: true
  };

  // Leave absent optional fields out so User's own defaults remain effective.
  if (hasValue(source.phone)) {
    const phone = normalizeMainlandChinaPhone(source.phone);
    if (phone) data.phone = phone;
  }
  if (hasValue(source.birthdate)) data.birthdate = source.birthdate;
  if (hasValue(source.locale)) data.locale = String(source.locale).trim();

  // This value is supplied by trusted server-side location lookup code. Never
  // merge or copy a location from the untrusted registration payload.
  if (serverLocation !== undefined && serverLocation !== null) {
    data.location = serverLocation;
  }

  return data;
}

module.exports = buildRegistrationUserData;
module.exports.buildRegistrationUserData = buildRegistrationUserData;


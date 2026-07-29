'use strict';

const MAINLAND_CHINA_PHONE_PATTERN = /^1\d{10}$/;

function normalizeMainlandChinaPhone(value) {
  return String(value || '').replace(/\D+/g, '');
}

function isValidMainlandChinaPhone(value) {
  return MAINLAND_CHINA_PHONE_PATTERN.test(normalizeMainlandChinaPhone(value));
}

function maskMainlandChinaPhone(value) {
  const phone = normalizeMainlandChinaPhone(value);
  return isValidMainlandChinaPhone(phone)
    ? `${phone.slice(0, 3)}****${phone.slice(-4)}`
    : '';
}

function parseOptionalMainlandChinaPhone(value) {
  const provided = Boolean(String(value || '').trim());
  const phone = provided ? normalizeMainlandChinaPhone(value) : '';
  return {
    provided,
    valid: !provided || isValidMainlandChinaPhone(phone),
    phone
  };
}

function isDuplicateMainlandChinaPhoneError(error) {
  if (!error || ![11000, 11001].includes(Number(error.code))) return false;

  const keyPattern = error.keyPattern || {};
  const keyValue = error.keyValue || {};
  return (
    Object.prototype.hasOwnProperty.call(keyPattern, 'phone') ||
    Object.prototype.hasOwnProperty.call(keyValue, 'phone') ||
    /phone_1/i.test(String(error.message || ''))
  );
}

module.exports = {
  MAINLAND_CHINA_PHONE_PATTERN,
  isDuplicateMainlandChinaPhoneError,
  isValidMainlandChinaPhone,
  maskMainlandChinaPhone,
  normalizeMainlandChinaPhone,
  parseOptionalMainlandChinaPhone
};

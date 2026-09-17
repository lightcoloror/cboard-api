'use strict';

const net = require('net');

const TRUST_PROXY_ENV = 'TRUST_PROXY_CIDRS';
const REJECTED_ENTRIES = new Set([
  'true',
  'false',
  '0',
  '0.0.0.0/0',
  '::/0'
]);

function isExplicitIpOrCidr(entry) {
  if (REJECTED_ENTRIES.has(entry.toLowerCase()) || /^\d+$/.test(entry)) return false;
  const parts = entry.split('/');
  if (parts.length > 2) return false;
  const address = parts[0];
  const family = net.isIP(address);
  if (!family) return false;
  if (parts.length === 1) return true;
  if (!/^\d+$/.test(parts[1])) return false;
  const prefix = Number(parts[1]);
  return prefix >= 1 && prefix <= (family === 4 ? 32 : 128);
}

function resolveTrustedProxyCidrs(env = process.env) {
  const raw = env[TRUST_PROXY_ENV];
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`${TRUST_PROXY_ENV} must contain one or more IP/CIDR entries`);
  }

  const entries = raw.split(',').map(entry => entry.trim());
  if (entries.some(entry => !isExplicitIpOrCidr(entry))) {
    throw new Error(`${TRUST_PROXY_ENV} contains an invalid trust entry`);
  }
  return entries;
}

function createTrustedProxyTrust(env = process.env) {
  const entries = resolveTrustedProxyCidrs(env);
  // Express compiles an address array with its own proxy-addr dependency.
  // Returning the public setting keeps this helper free of a transitive import.
  return entries.length === 0 ? false : entries;
}

module.exports = {
  TRUST_PROXY_ENV,
  createTrustedProxyTrust,
  resolveTrustedProxyCidrs
};

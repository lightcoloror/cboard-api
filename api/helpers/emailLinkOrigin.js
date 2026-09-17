'use strict';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function configuredEmailAppOrigin(config, env = process.env) {
  const raw =
    config.AUTH_EMAIL_APP_URL ||
    config.CBOARD_APP_URL;
  if (typeof raw !== 'string' || !raw.trim()) return null;

  let url;
  try {
    url = new URL(raw.trim());
  } catch (_) {
    return null;
  }

  const schemeEnd = raw.indexOf('://');
  const firstPathSlash = raw.indexOf('/', schemeEnd + 3);
  const rawPath = firstPathSlash === -1 ? '' : raw.slice(firstPathSlash).split(/[?#]/, 1)[0];

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== '/') ||
    (rawPath && rawPath !== '/')
  ) {
    return null;
  }

  const production = config.env === 'production' || env.NODE_ENV === 'production';
  if (production && url.protocol !== 'https:') return null;
  if (!production && url.protocol !== 'https:') {
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
      return null;
    }
  }

  return url.origin;
}

module.exports = { configuredEmailAppOrigin };

'use strict';

const PUBLIC_PICTOGRAM_PROVIDERS = new Set([
  'arasaac',
  'globalsymbols',
  'opensymbols',
  'mulberry',
  'cboard',
  'cboard-default'
]);

function normalizeString(value, maxLength) {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

function normalizeHttpsUrl(value, maxLength = 1000) {
  const normalized = normalizeString(value, maxLength);
  return /^https:\/\//i.test(normalized) ? normalized : null;
}

function normalizePublicPictogramAttribution(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const provider = normalizeString(value.provider, 40).toLowerCase();
  const originalId = normalizeString(value.originalId, 200);
  const name = normalizeString(value.name, 160);
  const license = normalizeString(value.license, 240);
  const sourceUrl = normalizeHttpsUrl(value.sourceUrl);
  if (
    !PUBLIC_PICTOGRAM_PROVIDERS.has(provider) ||
    !originalId ||
    !name ||
    !license ||
    !sourceUrl
  ) {
    return null;
  }

  return {
    provider,
    originalId,
    name,
    license,
    licenseUrl: normalizeHttpsUrl(value.licenseUrl),
    author: normalizeString(value.author, 160) || null,
    authorUrl: normalizeHttpsUrl(value.authorUrl),
    sourceUrl,
    repoKey: normalizeString(value.repoKey, 80) || null
  };
}

module.exports = {
  normalizeHttpsUrl,
  normalizePublicPictogramAttribution
};

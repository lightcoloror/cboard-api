'use strict';

const REQUEST_TIMEOUT_MS = 10000;

function assertCommunicationReadiness(body) {
  if (
    !body ||
    body.status !== 'ok' ||
    body.database !== 'connected' ||
    body.communicationIndexes !== 'ready'
  ) {
    throw new Error('Communication API is not ready');
  }
  return body;
}

async function verifyCommunicationReadiness(baseUrl, fetchImpl = fetch) {
  const healthUrl = new URL('/health', `${baseUrl.replace(/\/$/, '')}/`);
  const response = await fetchImpl(healthUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(`Health request failed: ${response.status}`);
  return assertCommunicationReadiness(body);
}

async function main() {
  const baseUrl =
    process.argv[2] ||
    process.env.CBOARD_API_BASE_URL ||
    'http://127.0.0.1:10010';
  await verifyCommunicationReadiness(baseUrl);
  console.log('Communication API database and required indexes are ready.');
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  assertCommunicationReadiness,
  verifyCommunicationReadiness
};

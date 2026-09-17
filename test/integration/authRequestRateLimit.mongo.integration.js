'use strict';

const assert = require('assert');
const mongoose = require('mongoose');
const {
  consumeAuthRequestLimits,
  createAuthRequestRateLimitRuntime,
  hashRateLimitIdentity
} = require('../../api/helpers/authRequestRateLimit');

const uri = process.env.CARE_TEST_MONGO_URI || '';
const uriPattern = /^mongodb:\/\/[^/?#@]+(?::\d+)?\/care_test_[a-f0-9]+$/i;
if (!uriPattern.test(uri)) {
  throw new Error('CARE_TEST_MONGO_URI must match mongodb://.../care_test_<hex>');
}

const config = {
  registration: { emailHourlyLimit: 3, ipHourlyLimit: 20 },
  passwordReset: { emailHourlyLimit: 3, ipHourlyLimit: 20 }
};
async function connect() {
  const connection = mongoose.createConnection();
  try {
    await connection.openUri(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      bufferCommands: false,
      serverSelectionTimeoutMS: 1000,
      connectTimeoutMS: 1000
    });
    return connection;
  } catch (error) {
    await connection.close().catch(() => {});
    throw error;
  }
}

function makeRuntime(connection) {
  return createAuthRequestRateLimitRuntime({
    storeClient: connection,
    config
  });
}

async function ready(runtime, operation) {
  const limiters = runtime.getLimiters(operation);
  await Promise.all(Object.values(limiters).map(limiter => limiter.createIndexes()));
  return limiters;
}

async function attempt(runtime, operation, email, ip) {
  try {
    await consumeAuthRequestLimits({
      limiters: runtime.getLimiters(operation), operation, email, ip
    });
    return { outcome: 'accepted' };
  } catch (error) {
    return { outcome: 'rejected', status: error.status, code: error.code };
  }
}

async function main() {
  const results = [];
  let first;
  let second;
  let primaryError;
  let cleanupError;
  let ownsDatabase = false;
  const database = new URL(uri).pathname.slice(1);
  try {
    first = await connect();
    second = await connect();
    assert.strictEqual(first.name, new URL(uri).pathname.slice(1));
    assert.strictEqual(second.name, first.name);
    assert.strictEqual((await first.db.listCollections().toArray()).length, 0);
    ownsDatabase = true;

    // Deliberately cold: constructors start index creation asynchronously. This
    // proves the first concurrent requests tolerate the library's cold start.
    const coldOne = makeRuntime(first);
    const coldTwo = makeRuntime(second);
    const coldAttempts = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      attempt(i % 2 ? coldTwo : coldOne, 'registration', 'cold@example.test', `203.0.113.${i + 1}`)));
    results.push({ name: 'cold_concurrent_email_cap', accepted: coldAttempts.filter(x => x.outcome === 'accepted').length, rejected429: coldAttempts.filter(x => x.status === 429).length });
    assert.strictEqual(results.at(-1).accepted, 3);
    assert.strictEqual(results.at(-1).rejected429, 2);

    const runtimeOne = makeRuntime(first);
    const runtimeTwo = makeRuntime(second);
    await Promise.all(['registration', 'passwordReset'].map(operation => ready(runtimeOne, operation)));
    await Promise.all(['registration', 'passwordReset'].map(operation => ready(runtimeTwo, operation)));

    const normalized = await Promise.all([
      attempt(runtimeOne, 'registration', '  MIXED@Example.Test ', '203.0.114.1'),
      attempt(runtimeTwo, 'registration', 'mixed@example.test', '203.0.114.2'),
      attempt(runtimeOne, 'registration', ' MIXED@example.test', '203.0.114.3'),
      attempt(runtimeTwo, 'registration', 'mixed@EXAMPLE.test ', '203.0.114.4')
    ]);
    results.push({ name: 'normalized_mailbox_combined', accepted: normalized.filter(x => x.outcome === 'accepted').length, rejected429: normalized.filter(x => x.status === 429).length });
    assert.strictEqual(results.at(-1).accepted, 3);
    assert.strictEqual(results.at(-1).rejected429, 1);

    const reset = await Promise.all(Array.from({ length: 4 }, () =>
      attempt(runtimeTwo, 'passwordReset', ' mixed@example.test ', '203.0.114.1')));
    results.push({ name: 'registration_reset_isolated', registrationConsumed: 3, resetAccepted: reset.filter(x => x.outcome === 'accepted').length });
    assert.strictEqual(results.at(-1).resetAccepted, 3);

    const freshRuntime = makeRuntime(second);
    const fresh = await attempt(freshRuntime, 'registration', 'cold@example.test', '203.0.116.1');
    results.push({ name: 'fresh_runtime_preserves_count', outcome: fresh.outcome, status: fresh.status });
    assert.strictEqual(fresh.status, 429);

    const ipRuntime = makeRuntime(first);
    await ready(ipRuntime, 'passwordReset');
    const ipEmail = 'ip-retention@example.test';
    const ipAttempts = await Promise.all(Array.from({ length: 4 }, () =>
      attempt(ipRuntime, 'passwordReset', ipEmail, '203.0.117.9')));
    const rejectedEmail = ipAttempts.find(x => x.status === 429);
    assert.strictEqual(ipAttempts.filter(x => x.outcome === 'accepted').length, 3);
    assert.ok(rejectedEmail);
    results.push({ name: 'ip_attempt_retained_after_email_rejection', acceptedBeforeRejection: ipAttempts.filter(x => x.outcome === 'accepted').length, rejectedEmail: rejectedEmail.status });
    assert.strictEqual(rejectedEmail.status, 429);
    const ipState = await ipRuntime.getLimiters('passwordReset').ipHourly.get(hashRateLimitIdentity('ip:203.0.117.9'));
    assert.strictEqual(ipState.consumedPoints, 4);

    const closedRuntime = makeRuntime(second);
    await ready(closedRuntime, 'registration');
    await second.close();
    second = null;
    const unavailable = await attempt(closedRuntime, 'registration', 'backend@example.test', '203.0.118.1');
    results.push({ name: 'backend_disconnect_fail_closed', outcome: unavailable.outcome, status: unavailable.status, code: unavailable.code });
    assert.strictEqual(unavailable.status, 503);
    assert.strictEqual(unavailable.code, 'USER_REGISTRATION_RATE_LIMIT_UNAVAILABLE');
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      if (ownsDatabase && first && first.readyState === 1) await first.dropDatabase();
    } catch (error) { cleanupError = error; }
    for (const connection of [first, second]) {
      if (connection) {
        try { await connection.close(); } catch (error) { cleanupError = cleanupError || error; }
      }
    }
  }
  const report = { result: primaryError || cleanupError ? 'failed' : 'passed', database, runtimes: 2, cases: results };
  if (primaryError) report.primary_error = { name: primaryError.name, message: primaryError.message };
  if (cleanupError) report.cleanup_error = { name: cleanupError.name, message: cleanupError.message };
  (primaryError || cleanupError ? console.error : console.log)(JSON.stringify(report, null, 2));
  if (primaryError || cleanupError) process.exitCode = 1;
}

main().catch(error => {
  console.error(JSON.stringify({ result: 'failed', error: error.message, name: error.name }));
  process.exitCode = 1;
});

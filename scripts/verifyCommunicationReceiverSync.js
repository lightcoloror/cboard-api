'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const assert = require('assert');
const axios = require('axios');

const REQUEST_TIMEOUT_MS = 10000;
const http = axios.create({ timeout: REQUEST_TIMEOUT_MS });

const API_BASE_URL = (
  process.env.LOCAL_RUNTIME_API_URL || 'http://127.0.0.1:10010'
).replace(/\/$/, '');
const email =
  process.env.LOCAL_RUNTIME_USER_EMAIL || 'local.runtime@example.com';
const password = process.env.LOCAL_RUNTIME_USER_PASSWORD || 'ChangeMe123!';

function findRecord(response, recordId) {
  return (response.data.records || []).find(record => record.id === recordId);
}

function findTombstone(response, recordId) {
  return (response.data.deletedRecords || []).find(
    record => record.id === recordId
  );
}

async function sync(headers, record) {
  return http.post(
    `${API_BASE_URL}/communication/receiver-records/sync`,
    { records: [record] },
    { headers }
  );
}

async function main() {
  const loginResponse = await http.post(`${API_BASE_URL}/user/login`, {
    email,
    password
  });
  const authToken = loginResponse.data.authToken;
  assert(authToken, 'Login did not return authToken');

  const headers = {
    Authorization: `Bearer ${authToken}`
  };
  const now = Date.now();
  const recordId = `runtime-receiver-${now}`;
  const original = {
    id: recordId,
    sessionId: `runtime-session-${now}`,
    patientId: 'runtime-patient',
    workspaceId: 'runtime-workspace',
    direction: 'receive',
    recordStatus: 'confirmed',
    inputText: '我想喝水',
    labels: ['我', '想', '喝水'],
    pictogramSequence: [
      {
        pictogramId: 'runtime-water',
        label: '喝水',
        source: 'local_dict',
        matchType: 'exact',
        confidence: 1,
        originalToken: '喝水'
      }
    ],
    contractVersion: 1,
    createdAt: now,
    updatedAt: now,
    confirmedAt: now,
    baseVersion: 0
  };

  const created = await sync(headers, original);
  assert.strictEqual(created.data.acceptedCount, 1);
  assert.strictEqual(created.data.conflictCount, 0);
  const versionOne = findRecord(created, recordId);
  assert(versionOne, 'Created record was not returned');
  assert.strictEqual(versionOne.serverVersion, 1);

  const deviceAFeedbackAt = now + 100;
  const deviceA = await sync(headers, {
    ...original,
    baseVersion: versionOne.serverVersion,
    updatedAt: deviceAFeedbackAt,
    patientFeedback: 'understood',
    patientFeedbackAt: deviceAFeedbackAt,
    patientFeedbackEvents: [
      { type: 'understood', createdAt: deviceAFeedbackAt }
    ]
  });
  const versionTwo = findRecord(deviceA, recordId);
  assert(versionTwo, 'Device A record was not returned');
  assert.strictEqual(versionTwo.serverVersion, 2);

  const deviceBFeedbackAt = now + 200;
  const staleDeviceB = await sync(headers, {
    ...original,
    inputText: '我要吃药',
    labels: ['我', '要', '吃药'],
    baseVersion: versionOne.serverVersion,
    updatedAt: deviceBFeedbackAt,
    patientFeedback: 'not_understood',
    patientFeedbackAt: deviceBFeedbackAt,
    patientFeedbackEvents: [
      { type: 'not_understood', createdAt: deviceBFeedbackAt }
    ]
  });
  assert.strictEqual(staleDeviceB.data.acceptedCount, 0);
  assert.strictEqual(staleDeviceB.data.conflictCount, 1);
  assert.deepStrictEqual(staleDeviceB.data.conflictedRecordIds, [recordId]);
  const canonical = findRecord(staleDeviceB, recordId);
  assert(canonical, 'Server canonical record was not returned');
  assert.strictEqual(canonical.inputText, original.inputText);
  assert.strictEqual(canonical.conflicted, true);
  assert.strictEqual(canonical.serverVersion, 3);
  assert.deepStrictEqual(
    canonical.patientFeedbackEvents.map(event => event.type),
    ['understood', 'not_understood']
  );

  const retry = await sync(headers, {
    ...original,
    baseVersion: canonical.serverVersion,
    updatedAt: canonical.updatedAt,
    patientFeedback: canonical.patientFeedback,
    patientFeedbackAt: canonical.patientFeedbackAt,
    patientFeedbackEvents: canonical.patientFeedbackEvents
  });
  assert.strictEqual(retry.data.conflictCount, 0);
  const settled = findRecord(retry, recordId);
  assert(settled, 'Settled record was not returned');
  assert.strictEqual(settled.conflicted, false);
  assert.strictEqual(settled.serverVersion, canonical.serverVersion);

  const deleted = await http.delete(
    `${API_BASE_URL}/communication/receiver-records`,
    {
      headers,
      data: { recordIds: [recordId] }
    }
  );
  assert.strictEqual(deleted.data.deletedCount, 1);
  const tombstone = findTombstone(deleted, recordId);
  assert(tombstone, 'Structured tombstone was not returned');
  assert.strictEqual(tombstone.serverVersion, settled.serverVersion + 1);
  assert(tombstone.deletedAt > 0);
  assert(tombstone.deletedBy);

  const resurrection = await sync(headers, {
    ...original,
    baseVersion: tombstone.serverVersion,
    updatedAt: now + 300
  });
  assert.strictEqual(resurrection.data.conflictCount, 1);
  assert.strictEqual(findRecord(resurrection, recordId), undefined);
  assert(findTombstone(resurrection, recordId));

  const concurrentRecordId = `runtime-concurrent-${now}`;
  const concurrentOriginal = {
    ...original,
    id: concurrentRecordId,
    sessionId: `runtime-concurrent-session-${now}`,
    createdAt: now + 1000,
    updatedAt: now + 1000,
    confirmedAt: now + 1000,
    baseVersion: 0
  };
  const concurrentCreated = await sync(headers, concurrentOriginal);
  const concurrentVersionOne = findRecord(
    concurrentCreated,
    concurrentRecordId
  );
  assert(concurrentVersionOne, 'Concurrent test record was not created');
  assert.strictEqual(concurrentVersionOne.serverVersion, 1);

  const concurrentAAt = now + 1100;
  const concurrentBAt = now + 1200;
  const feedbackA = { type: 'understood', createdAt: concurrentAAt };
  const feedbackB = {
    type: 'not_understood',
    createdAt: concurrentBAt
  };
  const [concurrentA, concurrentB] = await Promise.all([
    sync(headers, {
      ...concurrentOriginal,
      baseVersion: 1,
      updatedAt: concurrentAAt,
      patientFeedback: feedbackA.type,
      patientFeedbackAt: feedbackA.createdAt,
      patientFeedbackEvents: [feedbackA]
    }),
    sync(headers, {
      ...concurrentOriginal,
      baseVersion: 1,
      updatedAt: concurrentBAt,
      patientFeedback: feedbackB.type,
      patientFeedbackAt: feedbackB.createdAt,
      patientFeedbackEvents: [feedbackB]
    })
  ]);
  assert.strictEqual(
    concurrentA.data.conflictCount + concurrentB.data.conflictCount,
    1
  );
  const concurrentCanonical = [
    findRecord(concurrentA, concurrentRecordId),
    findRecord(concurrentB, concurrentRecordId)
  ]
    .filter(Boolean)
    .sort((left, right) => right.serverVersion - left.serverVersion)[0];
  assert(concurrentCanonical, 'Concurrent canonical record was not returned');

  const concurrentSettledResponse = await sync(headers, {
    ...concurrentOriginal,
    baseVersion: concurrentCanonical.serverVersion,
    updatedAt: concurrentBAt,
    patientFeedback: feedbackB.type,
    patientFeedbackAt: feedbackB.createdAt,
    patientFeedbackEvents: [feedbackA, feedbackB]
  });
  const concurrentSettled = findRecord(
    concurrentSettledResponse,
    concurrentRecordId
  );
  assert(concurrentSettled, 'Concurrent feedback retry did not settle');
  assert.deepStrictEqual(
    concurrentSettled.patientFeedbackEvents.map(event => event.type),
    ['understood', 'not_understood']
  );
  assert.strictEqual(concurrentSettled.conflicted, false);

  const concurrentDeleted = await http.delete(
    `${API_BASE_URL}/communication/receiver-records`,
    {
      headers,
      data: { recordIds: [concurrentRecordId] }
    }
  );
  assert.strictEqual(concurrentDeleted.data.deletedCount, 1);

  console.log(
    JSON.stringify(
      {
        ok: true,
        apiBaseUrl: API_BASE_URL,
        recordId,
        checked: [
          'authenticated-create',
          'device-a-feedback',
          'stale-device-canonical-conflict',
          'additive-feedback-retry',
          'structured-tombstone',
          'stale-resurrection-blocked',
          'simultaneous-feedback-conflict-retry'
        ],
        finalServerVersion: tombstone.serverVersion,
        concurrentServerVersion: concurrentSettled.serverVersion
      },
      null,
      2
    )
  );
}

main().catch(error => {
  console.error(error.response?.data || error.message || error);
  process.exitCode = 1;
});

'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const axios = require('axios');

const REQUEST_TIMEOUT_MS = 10000;
const http = axios.create({ timeout: REQUEST_TIMEOUT_MS });

const API_BASE_URL = (
  process.env.LOCAL_RUNTIME_API_URL || 'http://127.0.0.1:10010'
).replace(/\/$/, '');
const email =
  process.env.LOCAL_RUNTIME_USER_EMAIL || 'local.runtime@example.com';
const password = process.env.LOCAL_RUNTIME_USER_PASSWORD || 'ChangeMe123!';

const legacyPayload = {
  savedPhrases: [
    {
      sentence: 'legacy phrase',
      output: [{ label: 'drink', image: '', keyPath: '', id: 'legacy-output' }]
    }
  ],
  history: [
    {
      direction: 'receive',
      inputText: 'legacy input',
      labels: ['drink'],
      createdAt: '2026-01-01T00:00:00.000Z'
    }
  ]
};

const modernPayload = {
  savedPhrases: [
    {
      sentence: 'modern phrase',
      output: [{ label: 'water', image: '', keyPath: '', id: 'modern-output' }]
    }
  ],
  history: [
    {
      direction: 'receive',
      inputText: 'modern input',
      labels: ['water'],
      createdAt: '2026-01-02T00:00:00.000Z'
    }
  ]
};

async function main() {
  const loginResponse = await http.post(`${API_BASE_URL}/user/login`, {
    email,
    password
  });
  const authToken = loginResponse.data.authToken;

  if (!authToken) {
    throw new Error('Login did not return authToken');
  }

  const headers = {
    Authorization: `Bearer ${authToken}`
  };

  await http.post(
    `${API_BASE_URL}/settings`,
    {
      tuyujia: legacyPayload
    },
    { headers }
  );

  const legacySettingsResponse = await http.get(`${API_BASE_URL}/settings`, {
    headers
  });

  if (
    JSON.stringify(legacySettingsResponse.data.tuyujia || {}) !==
    JSON.stringify(legacyPayload)
  ) {
    throw new Error('Legacy tuyujia payload was not preserved');
  }

  await http.post(
    `${API_BASE_URL}/settings`,
    {
      communicationSupport: modernPayload,
      tuyujia: modernPayload
    },
    { headers }
  );

  const upgradedSettingsResponse = await http.get(`${API_BASE_URL}/settings`, {
    headers
  });

  const upgraded = upgradedSettingsResponse.data;
  if (
    JSON.stringify(upgraded.communicationSupport || {}) !==
    JSON.stringify(modernPayload)
  ) {
    throw new Error('communicationSupport payload was not preserved');
  }

  if (
    JSON.stringify(upgraded.tuyujia || {}) !== JSON.stringify(modernPayload)
  ) {
    throw new Error('legacy tuyujia compatibility payload was not preserved');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        apiBaseUrl: API_BASE_URL,
        checked: ['legacy-tuyujia-read', 'dual-write-readback']
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

'use strict';

const assert = require('assert');
const express = require('express');
const morgan = require('morgan');
const request = require('supertest');
const {
  createHttpLogFormat,
  registerHttpLoggerTokens
} = require('../../api/helpers/httpLogger');

function createLoggedApp() {
  const app = express();
  const lines = [];
  const stream = { write: line => lines.push(line) };
  registerHttpLoggerTokens(morgan);
  app.use(morgan(createHttpLogFormat(), { stream }));
  app.use((req, _res, next) => {
    if (req.path === '/health') {
      req.swagger = { operation: { operationId: 'getHealth' } };
    }
    next();
  });
  app.get('/health', (_req, res) => res.sendStatus(200));
  app.get('/activation/:token', (_req, res) => res.sendStatus(200));
  return { app, lines };
}

describe('HTTP privacy logger', () => {
  it('logs a fixed operation id while retaining method, status and duration', async () => {
    const { app, lines } = createLoggedApp();

    await request(app).get('/health?probe=id-token-and-code').expect(200);

    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /^GET getHealth 200 [0-9.]+ ms\n$/);
    assert.ok(!lines[0].includes('probe'));
    assert.ok(!lines[0].includes('id-token-and-code'));
  });

  it('uses the route template and never logs activation tokens or unknown query data', async () => {
    const { app, lines } = createLoggedApp();

    await request(app)
      .get('/activation/activation-secret?code=oauth-code&state=oauth-state&id_token=oauth-id-token')
      .expect(200);
    await request(app).get('/unknown/private-path?token=unknown-secret&code=unknown-code').expect(404);

    assert.match(lines[0], /^GET \/activation\/:token 200 [0-9.]+ ms\n$/);
    assert.match(lines[1], /^GET unmatched 404 [0-9.]+ ms\n$/);
    for (const secret of ['activation-secret', 'oauth-code', 'oauth-state', 'oauth-id-token', 'private-path', 'unknown-secret', 'unknown-code']) {
      assert.ok(!lines.join('').includes(secret), `secret leaked: ${secret}`);
    }
  });
});

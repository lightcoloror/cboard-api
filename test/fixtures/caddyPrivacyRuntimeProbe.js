'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const net = require('net');

const caddyPath = process.env.CADDY_BINARY || path.resolve(
  __dirname,
  '../../../../outputs/cboard-private-readiness-20260913/caddy-tools-2.11.4/bin/caddy.exe'
);
const marker = 'fixture-caddy-secret-token-7b4c';

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function startUpstream() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_request, response) => {
      response.setHeader('X-Upstream-Secret', marker);
      response.end('upstream');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function startClosedPort() {
  return reservePort();
}

function assertAdapted(caddyPath, configPath, env) {
  const result = spawnSync(caddyPath, ['adapt', '--config', configPath, '--adapter', 'caddyfile'], {
    cwd: path.dirname(configPath),
    env,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Caddy adapt failed for ${configPath}: ${result.stderr || result.stdout}`);
}

function request(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      headers: {
        Authorization: `Bearer ${marker}`,
        Cookie: `session=${marker}`,
        'X-Fixture-Token': marker,
        'Content-Type': 'text/plain'
      },
      method: 'POST'
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    req.once('error', reject);
    req.end(`body=${marker}`);
  });
}

async function main() {
  assert.ok(fs.existsSync(caddyPath), `missing caddy binary: ${caddyPath}`);
  const port = await reservePort();
  const failurePort = await startClosedPort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-privacy-'));
  const configPath = path.join(tempDir, 'Caddyfile');
  const productionCaddyfile = fs.readFileSync(path.resolve(__dirname, '../../deploy/Caddyfile'), 'utf8').replace(/\r\n/g, '\n');
  const productionPath = path.resolve(__dirname, '../../deploy/Caddyfile');
  const localPath = path.resolve(__dirname, '../../deploy/Caddyfile.local');
  const adaptEnv = {
    ...process.env,
    API_DOMAIN: 'localhost',
    ACME_EMAIL: 'ops@example.test',
    XDG_CONFIG_HOME: tempDir,
    XDG_DATA_HOME: tempDir
  };
  try {
    assertAdapted(caddyPath, productionPath, adaptEnv);
    assertAdapted(caddyPath, localPath, adaptEnv);
  } catch (error) {
    fs.rmSync(tempDir, {recursive: true, force: true});
    throw error;
  }
  const upstream = await startUpstream();
  const upstreamPort = upstream.address().port;
  const config = productionCaddyfile
    .replace('{$ACME_EMAIL}', 'ops@example.test')
    .replace('{$API_DOMAIN}', `http://127.0.0.1:${port}`)
    .replace('admin off\n', 'admin off\n\tauto_https off\n')
    .replace('\treverse_proxy api:10010 {', `\t@failure path /failure\n\thandle @failure {\n\t\treverse_proxy 127.0.0.1:${failurePort}\n\t}\n\n\t@upstream path /upstream\n\thandle @upstream {\n\t\treverse_proxy 127.0.0.1:${upstreamPort}\n\t}\n\n\treverse_proxy 127.0.0.1:${upstreamPort} {`);
  const siteAddress = `http://127.0.0.1:${port} {`;
  const isolatedConfig = config.replace(siteAddress, `${siteAddress}\n\tbind 127.0.0.1`);
  assert.notEqual(isolatedConfig, config, 'isolated site address replacement did not occur');
  assert.equal(isolatedConfig.includes('api:10010'), false, 'production upstream replacement did not occur');
  assert.equal(isolatedConfig.includes(`127.0.0.1:${upstreamPort}`), true, 'synthetic upstream missing');
  assert.equal(isolatedConfig.includes(`127.0.0.1:${failurePort}`), true, 'synthetic failure upstream missing');
  fs.writeFileSync(configPath, isolatedConfig, 'utf8');

  const output = [];
  let childError = null;
  const child = spawn(caddyPath, ['run', '--config', configPath, '--adapter', 'caddyfile'], {
    cwd: tempDir,
    env: {
      ...process.env,
      CADDY_ADMIN: 'off',
      XDG_CONFIG_HOME: tempDir,
      XDG_DATA_HOME: tempDir
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const childExit = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  child.once('error', error => { childError = error; });
  child.stdout.on('data', chunk => output.push(chunk.toString('utf8')));
  child.stderr.on('data', chunk => output.push(chunk.toString('utf8')));

  try {
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const poll = () => {
        const req = http.get({host: '127.0.0.1', port, path: '/ready'}, response => {
          response.resume();
          response.once('end', resolve);
        });
        req.once('error', () => {
          if (childError) reject(childError);
          else if (child.exitCode !== null) reject(new Error(`Caddy exited before readiness: ${child.exitCode}`));
          else if (Date.now() >= deadline) reject(new Error(`timed out waiting for Caddy; output=${output.join('')}`));
          else setTimeout(poll, 50);
        });
      };
      poll();
    });
    assert.equal(await request(port, `/ok?query=${marker}`), 200);
    assert.equal(await request(port, `/upstream?query=${marker}`), 200);
    assert.ok([502, 503, 504].includes(await request(port, `/failure?query=${marker}`)));
    const recordDeadline = Date.now() + 3000;
    let logText = '';
    let accessRecords = [];
    let errorRecords = [];
    while (Date.now() < recordDeadline) {
      logText = output.join('');
      const records = logText.split(/\r?\n/).filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch (_) { return null; }
      }).filter(Boolean);
      accessRecords = records.filter(record => record.logger === 'http.log.access.log0');
      errorRecords = records.filter(record => typeof record.logger === 'string' && record.logger.startsWith('http.log.error'));
      if (accessRecords.length >= 3 && errorRecords.length >= 1) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    logText = output.join('');
    assert.ok(accessRecords.length >= 3, `expected access records, got ${logText}`);
    assert.ok(errorRecords.length >= 1, `expected runtime error record, got ${logText}`);
    for (const record of [...accessRecords, ...errorRecords]) {
      assert.equal(Object.prototype.hasOwnProperty.call(record, 'msg'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(record, 'request'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(record, 'resp_headers'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(record, 'user_id'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(record, 'err'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(record, 'error'), false);
    }
    assert.ok(accessRecords.every(record => typeof record.status === 'number' && typeof record.duration === 'number'), 'access status/duration missing');
    assert.ok(errorRecords.every(record => typeof record.status === 'number' && typeof record.duration === 'number'), 'runtime error status/duration missing');
    assert.equal(logText.includes(marker), false, 'sensitive marker appeared in Caddy output');
    assert.equal(logText.includes('query='), false, 'query text appeared in Caddy output');
    assert.equal(logText.includes('Authorization'), false, 'authorization header appeared in Caddy output');
    assert.equal(logText.includes('Cookie'), false, 'cookie header appeared in Caddy output');
    assert.equal(logText.includes('X-Fixture-Token'), false, 'custom token header appeared in Caddy output');
    assert.equal(logText.includes('body='), false, 'request body appeared in Caddy output');
    process.stdout.write(JSON.stringify({accessRecords: accessRecords.length, errorRecords: errorRecords.length, markerPresent: false, queryPresent: false, headerPresent: false, bodyPresent: false}));
  } finally {
    if (child.pid && child.exitCode === null) {
      child.kill();
      await childExit;
    }
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(tempDir, {recursive: true, force: true});
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

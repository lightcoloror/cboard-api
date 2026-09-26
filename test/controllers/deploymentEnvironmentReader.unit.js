'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  parseFieldList,
  readDeploymentEnvironment
} = require('../../scripts/readDeploymentEnvironment');

const sourceRoot = path.resolve(__dirname, '../../');
const shellScript = path.join(sourceRoot, 'deploy', 'scripts', 'read-deployment-env.sh');
const noNodePath = () => (process.env.PATH || '').split(path.delimiter).filter(entry => !/node/i.test(entry)).join(path.delimiter);

const gitBash = [
  process.env.RESTORE_TEST_BASH,
  process.env.GIT_BASH_PATH,
  'D:\\Program Files\\Git\\bin\\bash.exe',
  'D:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
].find(candidate => candidate && fs.existsSync(candidate));
const bash = process.platform === 'win32' ? gitBash : 'bash';
const fallbackPath = () => [path.dirname(bash || ''), noNodePath()].filter(Boolean).join(path.delimiter);

// Keep this focused helper runnable by the managed Node adapter even when the
// checkout has no installed Mocha dependencies. Mocha still supplies the
// normal describe/it globals in the project test runner.
if (typeof describe !== 'function') {
  global.describe = (_name, callback) => callback();
  global.it = (name, callback) => {
    try {
      callback.call({ skip() { return undefined; } });
      process.stdout.write(`ok - ${name}\n`);
    } catch (error) {
      process.stderr.write(`not ok - ${name}: ${error.stack || error.message}\n`);
      process.exitCode = 1;
    }
  };
}

describe('deployment environment reader', function() {
  it('selects exactly requested fields and supports JSON without exposing other values', function() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cboard-env-reader-'));
    const file = path.join(root, '.env');
    const secret = 'private-value-that-must-not-be-selected';
    fs.writeFileSync(file, `DEPLOYMENT_PROJECT_NAME=cboard-care-test\nVISIBLE=yes\nSECRET=${secret}\n`);
    try {
      assert.equal(readDeploymentEnvironment({
        environmentPath: file, fields: parseFieldList('DEPLOYMENT_PROJECT_NAME,VISIBLE'), json: true
      }), '{"DEPLOYMENT_PROJECT_NAME":"cboard-care-test","VISIBLE":"yes"}');
      assert.doesNotMatch(readDeploymentEnvironment({
        environmentPath: file, fields: ['DEPLOYMENT_PROJECT_NAME'], json: false
      }), new RegExp(secret));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects malformed or duplicate allow-list fields and missing fields', function() {
    assert.throws(() => parseFieldList('A,A'), /duplicate/);
    assert.throws(() => parseFieldList('A;rm'), /invalid/);
    assert.throws(() => readDeploymentEnvironment({ environmentPath: __filename, fields: ['A;rm'], json: true }), /invalid/);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cboard-env-reader-'));
    const file = path.join(root, '.env');
    fs.writeFileSync(file, 'A=one\n');
    try {
      assert.throws(() => readDeploymentEnvironment({ environmentPath: file, fields: ['MISSING'], json: true }), /missing/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('uses the cache-only hardened Docker fallback and accepts only an explicit digest override', function() {
    if (!bash) return this.skip();
    const shellSource = fs.readFileSync(shellScript, 'utf8');
    assert.match(shellSource, /--pull=never/);
    assert.match(shellSource, /--network none/);
    assert.match(shellSource, /--read-only/);
    assert.match(shellSource, /--cap-drop=ALL/);
    assert.match(shellSource, /--entrypoint node/);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cboard-env-shell-'));
    const bin = path.join(root, 'bin');
    const envFile = path.join(root, '.env');
    const log = path.join(root, 'docker.log');
    fs.mkdirSync(bin);
    fs.writeFileSync(envFile, 'DEPLOYMENT_PROJECT_NAME=cboard-care-test\n');
    fs.writeFileSync(log, '');
    const docker = path.join(bin, 'docker');
    fs.writeFileSync(docker, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$FAKE_DOCKER_LOG"\nprintf \'%s\' \'{"DEPLOYMENT_PROJECT_NAME":"cboard-care-test"}\'\n', { mode: 0o755 });
    try {
      const result = spawnSync(bash, [shellScript, filePath(envFile), 'DEPLOYMENT_PROJECT_NAME'], {
        env: { ...process.env, PATH: `${bin}${path.delimiter}${fallbackPath()}`, FAKE_DOCKER_LOG: filePath(log), CARE_NODE_IMAGE: 'sha256:' + 'a'.repeat(64) },
        encoding: 'utf8', timeout: 15000
      });
      if (result.error && result.error.code === 'EPERM') return;
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ? result.error.stack || result.error.message : ''}`);
      const command = fs.readFileSync(log, 'utf8');
      assert.match(command, /--pull=never/);
      assert.match(command, /--network none/);
      assert.match(command, /--read-only/);
      assert.match(command, /--cap-drop=ALL/);
      assert.match(command, /--security-opt no-new-privileges/);
      assert.match(command, /--user 0/);
      assert.match(command, /--memory=128m/);
      assert.match(command, /--pids-limit=32/);
      assert.match(command, /--entrypoint node/);
      assert.match(command, /sha256:/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects an unpinned fallback image override before Docker', function() {
    if (!bash) return this.skip();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cboard-env-shell-'));
    const bin = path.join(root, 'bin');
    const envFile = path.join(root, '.env');
    const log = path.join(root, 'docker.log');
    fs.mkdirSync(bin);
    fs.writeFileSync(envFile, 'A=one\n');
    fs.writeFileSync(log, '');
    fs.writeFileSync(path.join(bin, 'docker'), '#!/usr/bin/env bash\nprintf called >> "$FAKE_DOCKER_LOG"\n', { mode: 0o755 });
    try {
      const result = spawnSync(bash, [shellScript, filePath(envFile), 'A'], {
        env: { ...process.env, PATH: `${bin}${path.delimiter}${fallbackPath()}`, FAKE_DOCKER_LOG: filePath(log), CARE_NODE_IMAGE: 'node:latest' },
        encoding: 'utf8', timeout: 15000
      });
      if (result.error && result.error.code === 'EPERM') return;
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /called/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

function filePath(value) {
  const absolute = path.resolve(value);
  if (process.platform !== 'win32') return absolute;
  // The deployment scripts consume POSIX absolute paths inside Git Bash.
  return absolute.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

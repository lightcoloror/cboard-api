'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const gitBash = [
  process.env.RESTORE_TEST_BASH,
  process.env.GIT_BASH_PATH,
  'D:\\Program Files\\Git\\bin\\bash.exe',
  'D:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
].find(candidate => candidate && fs.existsSync(candidate));
const bash = process.platform === 'win32' ? gitBash : 'bash';

if (!bash) throw new Error('Git Bash is required for restore-mongo shell tests');

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function fixture(state) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cboard-restore-test-'));
  const bin = path.join(root, 'bin');
  const scripts = path.join(root, 'deploy', 'scripts');
  fs.mkdirSync(bin);
  fs.mkdirSync(scripts, { recursive: true });
  const archive = path.join(root, 'backup.gz');
  const environment = path.join(root, 'deploy', '.env.production');
  const log = path.join(root, 'docker.log');
  fs.writeFileSync(archive, 'synthetic archive');
  fs.writeFileSync(environment, 'DEPLOYMENT_PROJECT_NAME=restore-test\n');
  fs.writeFileSync(log, '');
  for (const name of ['restore-mongo.sh', 'docker-runtime.sh']) {
    fs.copyFileSync(path.resolve(__dirname, '../../deploy/scripts', name), path.join(scripts, name));
  }
  writeExecutable(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$1" == "info" ]]; then exit 0; fi
if [[ "$*" == *"config --quiet"* || "$*" == *"up -d --build"* ]]; then exit 0; fi
if [[ "$*" == *"ps --all --quiet api"* ]]; then
  if [[ "$FAKE_API_STATE" == "query-error" ]]; then exit 17; fi
  if [[ "$FAKE_API_STATE" != "uncreated" ]]; then
    if [[ "$FAKE_API_STATE" == "mixed" ]]; then printf 'api-one\\napi-two\\n'; else echo api-one; fi
  fi
  exit 0
fi
if [[ "$1" == "inspect" ]]; then
  if [[ "$FAKE_API_STATE" == "inspect-error" ]]; then exit 17; fi
  case "$FAKE_API_STATE" in
    stopped) echo exited ;;
    created) echo created ;;
    mixed) printf 'exited\\nrunning\\n' ;;
    *) echo "$FAKE_API_STATE" ;;
  esac
  exit 0
fi
if [[ "$*" == *"exec -T mongo"* ]]; then cat >/dev/null; exit 0; fi
echo "unexpected docker command: $*" >&2
exit 19
`);
  return { root, archive, environment, log, bin, state, restoreScript: path.join(scripts, 'restore-mongo.sh') };
}

describe('deployment and backup project identity', function() {
  it('refuses a database-only restore for a dedicated Care project before Docker or hold writes', function() {
    const f = fixture('stopped');
    try {
      fs.writeFileSync(f.environment, 'DEPLOYMENT_PROJECT_NAME=cboard-care-synthetic\n');
      const result = restore(f);
      assert.notStrictEqual(result.status, 0);
      if (result.error) throw result.error;
      assert.match(result.stderr, /coordinated database, private media and separate key restore/);
      assert.strictEqual(fs.readFileSync(f.log, 'utf8'), '');
      assert.strictEqual(fs.existsSync(path.join(f.root, 'deploy', '.restore-security-review-required.cboard-care-synthetic')), false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('refuses a database-only backup for a dedicated Care project before creating output', function() {
    const f = fixture('stopped');
    try {
      fs.writeFileSync(f.environment, 'DEPLOYMENT_PROJECT_NAME=cboard-care-synthetic\n');
      const backupDir = path.join(f.root, 'backups');
      const result = spawnSync(bash, [path.resolve(__dirname, '../../deploy/scripts/backup-mongo.sh'), f.environment], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, BACKUP_DIR: backupDir, FAKE_DOCKER_LOG: f.log,
          PATH: `${f.bin}${path.delimiter}${process.env.PATH || ''}` }
      });
      assert.notStrictEqual(result.status, 0);
      if (result.error) throw result.error;
      assert.match(result.stderr, /database-only backup refused/);
      assert.strictEqual(fs.existsSync(backupDir), false);
      assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /mongodump|compose/);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  for (const mode of ['success', 'partial-failure', 'empty']) {
    it(`publishes a backup only after a successful nonempty dump: ${mode}`, function() {
      const f = fixture('stopped');
      try {
        writeExecutable(path.join(f.bin, 'docker'), `#!/usr/bin/env bash
if [[ "$1" == "info" ]]; then exit 0; fi
if [[ "$*" != *"mongodump"* ]]; then exit 19; fi
if [[ "$FAKE_DUMP_MODE" == "empty" ]]; then exit 0; fi
printf 'synthetic archive bytes'
if [[ "$FAKE_DUMP_MODE" == "partial-failure" ]]; then exit 17; fi
`);
        const backupDir = path.join(f.root, 'backups');
        const result = spawnSync(bash, [path.resolve(__dirname, '../../deploy/scripts/backup-mongo.sh'), f.environment], {
          encoding: 'utf8', timeout: 10000,
          env: { ...process.env, BACKUP_DIR: backupDir, FAKE_DUMP_MODE: mode,
            PATH: `${f.bin}${path.delimiter}${process.env.PATH || ''}` }
        });
        const files = fs.readdirSync(backupDir);
        if (mode === 'success') {
          assert.strictEqual(result.status, 0, result.stderr);
          assert.strictEqual(files.length, 1);
          assert.match(files[0], /^mongo-.*\.archive\.gz$/);
          assert.strictEqual(fs.readFileSync(path.join(backupDir, files[0]), 'utf8'), 'synthetic archive bytes');
        } else {
          assert.notStrictEqual(result.status, 0);
          assert.deepStrictEqual(files, []);
          assert.doesNotMatch(result.stdout, /backup created/);
        }
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });
  }
  for (const project of ['restore-test', 'Invalid Project']) {
    it(`uses the configured project or refuses invalid identity: ${project}`, function() {
      const f = fixture('stopped');
      try {
        fs.writeFileSync(f.environment, `DEPLOYMENT_PROJECT_NAME=${project}\nAPI_DOMAIN=synthetic.invalid\n`);
        // Stub validation/network tools: this test executes only shell orchestration.
        writeExecutable(path.join(f.bin, 'node'), '#!/usr/bin/env bash\nexit 0\n');
        const scripts = path.join(f.root, 'deploy', 'scripts');
        fs.mkdirSync(scripts, { recursive: true });
        for (const name of ['deploy.sh', 'docker-runtime.sh']) {
          fs.copyFileSync(path.resolve(__dirname, '../../deploy/scripts', name), path.join(scripts, name));
        }
        writeExecutable(path.join(scripts, 'health-check.sh'), '#!/usr/bin/env bash\nexit 0\n');
        const result = spawnSync(bash, [path.join(scripts, 'deploy.sh'), f.environment], {
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, FAKE_DOCKER_LOG: f.log, FAKE_API_STATE: f.state,
            PATH: `${f.bin}${path.delimiter}${process.env.PATH || ''}` }
        });
        const log = fs.readFileSync(f.log, 'utf8');
        if (project === 'restore-test') {
          assert.strictEqual(result.status, 0, result.stderr);
          const compose = log.split('\n').filter(line => line.startsWith('compose '));
          assert.strictEqual(compose.length, 2);
          for (const line of compose) assert.match(line, /^compose --project-name restore-test /);
        } else {
          assert.notStrictEqual(result.status, 0);
          assert.match(result.stderr, /DEPLOYMENT_PROJECT_NAME is missing or invalid/);
          assert.doesNotMatch(log, /compose /);
        }
      } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    });
  }
});

function restore(f) {
  return spawnSync(bash, [f.restoreScript, f.environment, f.archive], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CONFIRM_RESTORE: 'RESTORE',
      FAKE_API_STATE: f.state,
      FAKE_DOCKER_LOG: f.log,
      PATH: `${f.bin}${path.delimiter}${process.env.PATH || ''}`
    }
  });
}

describe('restore-mongo API stop guard', function() {
  for (const [state, expected] of [
    ['running', 'Restore refused while an API container is running'],
    ['restarting', 'Restore refused while an API container is restarting'],
    ['paused', 'Restore refused while an API container is paused'],
    ['query-error', 'Unable to verify whether the API service is stopped'],
    ['inspect-error', 'Unable to verify whether the API service is stopped'],
    ['mixed', 'Restore refused while an API container is running']
  ]) {
    it(`refuses restore when API state is ${state}`, function() {
      const f = fixture(state);
      try {
        const result = restore(f);
        assert.notStrictEqual(result.status, 0);
        assert.match(result.stderr, new RegExp(expected));
        const log = fs.readFileSync(f.log, 'utf8');
        assert.match(log, /ps --all --quiet api/);
        assert.doesNotMatch(log, /exec -T mongo/);
      } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    });
  }

  it('restores only after every API container is stopped', function() {
    const f = fixture('stopped');
    try {
      const result = restore(f);
      assert.strictEqual(result.status, 0, result.stderr);
      const log = fs.readFileSync(f.log, 'utf8');
      assert.match(log, /ps --all --quiet api/);
      assert.match(log, /inspect --format \{\{\.State\.Status\}\} api-one/);
      assert.match(log, /exec -T mongo/);
      assert.doesNotMatch(log, /\bup\b|\bstart\b/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
});

function deploymentFixture(state = 'stopped') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cboard-restore-hold-test-'));
  const scripts = path.join(root, 'deploy', 'scripts');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'docker.log');
  const healthLog = path.join(root, 'health.log');
  const archive = path.join(root, 'backup.gz');
  const production = path.join(root, 'deploy', '.env.production');
  const privateEnv = path.join(root, 'deploy', '.env.private');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(archive, 'synthetic archive');
  fs.writeFileSync(production, 'DEPLOYMENT_PROJECT_NAME=restore-test\n');
  fs.writeFileSync(privateEnv, 'DEPLOYMENT_PROJECT_NAME=cboard-api-private\n');
  fs.writeFileSync(log, '');
  fs.writeFileSync(healthLog, '');
  for (const name of ['restore-mongo.sh', 'docker-runtime.sh', 'deploy.sh', 'deploy-private.sh']) {
    fs.copyFileSync(path.resolve(__dirname, '../../deploy/scripts', name), path.join(scripts, name));
  }
  for (const name of ['health-check.sh', 'health-check-private.sh']) {
    writeExecutable(path.join(scripts, name), [
      '#!/usr/bin/env bash', 'set -euo pipefail',
      'printf "%s\\n" "$0" >> "$FAKE_HEALTH_LOG"'
    ].join('\n'));
  }
  writeExecutable(path.join(bin, 'node'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(path.join(bin, 'docker'), [
    '#!/usr/bin/env bash', 'set -euo pipefail',
    'printf "%s\\n" "$*" >> "$FAKE_DOCKER_LOG"',
    'if [[ "$1" == "info" ]]; then exit 0; fi',
    'if [[ "$*" == *"ps --all --quiet api"* ]]; then',
    '  if [[ "$FAKE_API_STATE" == "query-error" ]]; then exit 17; fi',
    '  if [[ "$FAKE_API_STATE" != "uncreated" ]]; then echo api-one; fi',
    '  exit 0',
    'fi',
    'if [[ "$1" == "inspect" ]]; then',
    '  if [[ "$FAKE_API_STATE" == "inspect-error" ]]; then exit 17; fi',
    '  case "$FAKE_API_STATE" in',
    '    stopped) echo exited ;;', '    created) echo created ;;',
    '    *) echo "$FAKE_API_STATE" ;;', '  esac', '  exit 0',
    'fi',
    'if [[ "$*" == *"exec -T mongo"* ]]; then',
    '  cat >/dev/null',
    '  if [[ "${FAKE_MONGORESTORE:-}" == "failure" ]]; then exit 17; fi',
    '  exit 0', 'fi',
    'if [[ "$*" == *"config --quiet"* || "$*" == *"up -d --build"* ]]; then exit 0; fi',
    'echo "unexpected docker command: $*" >&2', 'exit 19'
  ].join('\n'));
  return {
    root, scripts, bin, log, healthLog, archive, production, privateEnv,
    restoreScript: path.join(scripts, 'restore-mongo.sh'),
    deployScript: path.join(scripts, 'deploy.sh'),
    deployPrivateScript: path.join(scripts, 'deploy-private.sh'), state
  };
}

function markerPath(f, projectName) {
  return path.join(f.root, 'deploy', `.restore-security-review-required.${projectName}`);
}

function runProjectScript(f, scriptPath, args, extraEnv = {}) {
  return spawnSync(bash, [scriptPath, ...args], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, FAKE_API_STATE: f.state, FAKE_DOCKER_LOG: f.log,
      FAKE_HEALTH_LOG: f.healthLog, PATH: `${f.bin}${path.delimiter}${process.env.PATH || ''}`,
      ...extraEnv }
  });
}

describe('restore security hold marker and deployment gate', function() {
  it('writes and retains the marker after a successful restore', function() {
    const f = deploymentFixture('stopped');
    try {
      const result = runProjectScript(f, f.restoreScript, [f.production, f.archive], {
        CONFIRM_RESTORE: 'RESTORE'
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(fs.lstatSync(markerPath(f, 'restore-test')).isFile(), true);
      const log = fs.readFileSync(f.log, 'utf8');
      assert.match(log, /exec -T mongo/);
      assert.doesNotMatch(log, /compose .*\b(up|start)\b/);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('retains the marker after mongorestore failure and does not start or health-check', function() {
    const f = deploymentFixture('stopped');
    try {
      const result = runProjectScript(f, f.restoreScript, [f.production, f.archive], {
        CONFIRM_RESTORE: 'RESTORE', FAKE_MONGORESTORE: 'failure'
      });
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(fs.lstatSync(markerPath(f, 'restore-test')).isFile(), true);
      const log = fs.readFileSync(f.log, 'utf8');
      assert.match(log, /exec -T mongo/);
      assert.doesNotMatch(log, /compose .*\b(up|start)\b/);
      assert.strictEqual(fs.readFileSync(f.healthLog, 'utf8'), '');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('does not write the marker when restore prechecks fail', function() {
    const f = deploymentFixture('running');
    try {
      const result = runProjectScript(f, f.restoreScript, [f.production, f.archive], {
        CONFIRM_RESTORE: 'RESTORE'
      });
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(fs.existsSync(markerPath(f, 'restore-test')), false);
      const log = fs.readFileSync(f.log, 'utf8');
      assert.match(log, /ps --all --quiet api/);
      assert.doesNotMatch(log, /exec -T mongo/);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  for (const [name, scriptKey, envKey, projectName] of [
    ['deploy.sh', 'deployScript', 'production', 'restore-test'],
    ['deploy-private.sh', 'deployPrivateScript', 'privateEnv', 'cboard-api-private']
  ]) {
    it(`${name} refuses a regular hold before compose up and health`, function() {
      const f = deploymentFixture('stopped');
      try {
        fs.writeFileSync(markerPath(f, projectName), 'review required');
        const result = runProjectScript(f, f[scriptKey], [f[envKey]]);
        assert.notStrictEqual(result.status, 0, `${name} unexpectedly succeeded`);
        assert.match(`${result.stdout}\n${result.stderr}`, /restore|security|review|hold/i);
        assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /compose .*\bup\b/);
        assert.strictEqual(fs.readFileSync(f.healthLog, 'utf8'), '');
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });

    it(`${name} refuses a symlink or reparse-point hold before compose up and health`, function() {
      const f = deploymentFixture('stopped');
      try {
        const marker = markerPath(f, projectName);
        const target = path.join(f.root, 'restore-hold-target');
        fs.mkdirSync(target);
        // Windows policy commonly denies file symlinks. A junction is a
        // symlink-like reparse point and Git Bash reports it to [[ -L ]].
        try { fs.symlinkSync('restore-hold-target', marker, 'file'); }
        catch (error) {
          if (!error || error.code !== 'EPERM') throw error;
          fs.symlinkSync(target, marker, 'junction');
        }
        const result = runProjectScript(f, f[scriptKey], [f[envKey]]);
        assert.notStrictEqual(result.status, 0, `${name} unexpectedly succeeded`);
        assert.match(`${result.stdout}\n${result.stderr}`, /restore|security|review|hold/i);
        assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /compose .*\bup\b/);
        assert.strictEqual(fs.readFileSync(f.healthLog, 'utf8'), '');
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });

    it(`${name} keeps normal compose and health behavior without a hold`, function() {
      const f = deploymentFixture('stopped');
      try {
        const result = runProjectScript(f, f[scriptKey], [f[envKey]]);
        assert.strictEqual(result.status, 0, result.stderr);
        const log = fs.readFileSync(f.log, 'utf8');
        assert.match(log, /compose .*config --quiet/);
        assert.match(log, /compose .*up -d --build/);
        assert.notStrictEqual(fs.readFileSync(f.healthLog, 'utf8'), '');
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });
  }
});

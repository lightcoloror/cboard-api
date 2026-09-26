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
if (!bash) throw new Error('Git Bash is required for Care closure shell tests');

const sourceRoot = path.resolve(__dirname, '../../deploy');

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function toGitPath(file) {
  const normalized = file.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized)) return `/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
  return normalized;
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cboard-care-closure-test-'));
  const bin = path.join(root, 'bin');
  const scripts = path.join(root, 'deploy', 'scripts');
  const environment = path.join(root, 'deploy', '.env.care');
  const log = path.join(root, 'docker.log');
  const bashEnv = path.join(root, 'bash.env');
  fs.mkdirSync(bin);
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(log, '');
  fs.writeFileSync(environment, [
    `DEPLOYMENT_PROJECT_NAME=${options.project || 'cboard-care-test'}`,
    `CARE_CLOSURE_WORKER_ENABLED=${options.workerEnabled === false ? 'false' : 'true'}`,
    'MONGO_URL=mongodb://worker:secret@example.invalid/care?replicaSet=care-rs',
    'MONGO_PASSWORD=do-not-print-this',
    ''
  ].join('\n'));
  fs.writeFileSync(bashEnv, 'export PATH="$FAKE_BIN:$PATH"\n');
  writeExecutable(path.join(bin, 'flock'), '#!/usr/bin/env bash\n[[ "${FAKE_API_STATE:-}" != "maintenance-busy" ]]\n');
  for (const name of ['run-care-closure.sh', 'docker-runtime.sh', 'read-deployment-env.sh']) {
    fs.copyFileSync(path.join(sourceRoot, 'scripts', name), path.join(scripts, name));
  }
  writeExecutable(path.join(bin, 'node'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == *readDeploymentEnvironment.js ]]; then
  fields=""
  while [[ \"\${1:-}\" != \"\" ]]; do
    if [[ \"\${1:-}\" == --fields ]]; then fields=\"\${2:-}\"; shift 2; else shift; fi
  done
  IFS=, read -ra requested <<< \"\$fields\"
  for field in \"\${requested[@]}\"; do
    case \"\$field\" in
      DEPLOYMENT_PROJECT_NAME) printf '%s\\n' \"DEPLOYMENT_PROJECT_NAME=\${FAKE_PROJECT_NAME}\" ;;
      CARE_CLOSURE_WORKER_ENABLED) printf '%s\\n' \"CARE_CLOSURE_WORKER_ENABLED=\${FAKE_WORKER_ENABLED}\" ;;
      *) exit 1 ;;
    esac
  done
  exit 0
fi
if [[ "\${1:-}" == "-e" ]]; then
  case "\${5:-}" in
    DEPLOYMENT_PROJECT_NAME) printf '%s' "\${FAKE_PROJECT_NAME}" ;;
    CARE_CLOSURE_WORKER_ENABLED) printf '%s' "\${FAKE_WORKER_ENABLED}" ;;
    *) exit 1 ;;
  esac
fi
`);
  writeExecutable(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ "\${1:-}" == "info" ]]; then exit 0; fi
if [[ "$*" == *"ps --filter"* ]]; then
  case "\${FAKE_API_STATE:-healthy}" in
    healthy|tools-missing|worker-success|worker-failed|worker-timeout|lock-busy) echo api-fixed-id ;;
    multiple) printf 'api-one\\napi-two\\n' ;;
    wrong-label|unhealthy) echo api-fixed-id ;;
    *) ;;
  esac
  exit 0
fi
if [[ "$*" == *"inspect --format"* ]]; then
  case "\${FAKE_API_STATE:-healthy}" in
    wrong-label) echo 'cboard-care-other|api|running|healthy' ;;
    unhealthy) echo 'cboard-care-test|api|running|starting' ;;
    stopped) echo 'cboard-care-test|api|exited|healthy' ;;
    *) echo 'cboard-care-test|api|running|healthy' ;;
  esac
  exit 0
fi
if [[ "$*" == *"exec "* && "$*" == *"command -v timeout"* ]]; then
  [[ "\${FAKE_API_STATE:-healthy}" != "tools-missing" ]]
  exit $?
fi
if [[ "$*" == *"exec "*"flock -n /tmp/care-closure-worker.lock"* ]]; then
  case "\${FAKE_API_STATE:-healthy}" in
    worker-failed) exit 2 ;;
    worker-timeout) exit 124 ;;
    lock-busy) exit 1 ;;
    *) exit 0 ;;
  esac
fi
echo "unexpected docker command: $*" >&2
exit 19
`);
  return {
    root,
    bin,
    fakeBin: toGitPath(bin),
    bashEnv,
    environment,
    log,
    script: path.join(scripts, 'run-care-closure.sh'),
    project: options.project || 'cboard-care-test'
  };
}

function run(f, options = {}) {
  return spawnSync(bash, [toGitPath(f.script), toGitPath(f.environment)], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    env: {
      ...process.env,
      BASH_ENV: f.bashEnv,
      FAKE_BIN: f.fakeBin,
      FAKE_DOCKER_LOG: f.log,
      FAKE_PROJECT_NAME: f.project,
      FAKE_WORKER_ENABLED: options.workerEnabled === false ? 'false' : 'true',
      FAKE_API_STATE: options.apiState || 'healthy',
      PATH: `${f.bin}${path.delimiter}${process.env.PATH || ''}`
    }
  });
}

function output(result, f) {
  return `${result.stdout || ''}\n${result.stderr || ''}\n${result.error ? result.error.stack || result.error.message : ''}\nDocker log:\n${fs.readFileSync(f.log, 'utf8')}`;
}

function log(f) {
  return fs.readFileSync(f.log, 'utf8').trim().split(/\r?\n/).filter(Boolean);
}

function assertNoExec(f) {
  assert.doesNotMatch(log(f).join('\n'), /exec /);
}

describe('run-care-closure.sh gates', function() {
  it('refuses closure before Docker access when backup holds the maintenance lock', function() {
    const f = fixture();
    try {
      const result = run(f, { apiState: 'maintenance-busy' });
      assert.notStrictEqual(result.status, 0);
      if (result.error) throw result.error;
      assert.match(result.stderr, /maintenance is busy/);
      assert.strictEqual(fs.readFileSync(f.log, 'utf8'), '');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('rejects non-Care project identity without Docker access', function() {
    const f = fixture({ project: 'cboard-api-private' });
    try {
      const result = run(f);
      assert.notStrictEqual(result.status, 0);
      assert.match(output(result, f), /dedicated cboard-care/);
      assert.strictEqual(fs.readFileSync(f.log, 'utf8'), '');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('requires explicit closure worker enablement', function() {
    const f = fixture({ workerEnabled: false });
    try {
      const result = run(f, { workerEnabled: false });
      assert.notStrictEqual(result.status, 0);
      assert.match(output(result, f), /CARE_CLOSURE_WORKER_ENABLED/);
      assert.strictEqual(fs.readFileSync(f.log, 'utf8'), '');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('honors restore hold before Docker discovery', function() {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.root, 'deploy', `.restore-security-review-required.${f.project}`), 'review required');
      const result = run(f);
      assert.notStrictEqual(result.status, 0);
      assert.match(output(result, f), /Restore security review required/);
      assert.strictEqual(fs.readFileSync(f.log, 'utf8'), '');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  for (const [apiState, expected] of [
    ['stopped', /No running Care API/],
    ['multiple', /exactly one/],
    ['wrong-label', /identity or health/],
    ['unhealthy', /identity or health/]
  ]) {
    it(`rejects API state ${apiState} before worker exec`, function() {
      const f = fixture();
      try {
        const result = run(f, { apiState });
        assert.notStrictEqual(result.status, 0);
        assert.match(output(result, f), expected);
        assertNoExec(f);
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });
  }

  it('fails closed when container utilities are unavailable', function() {
    const f = fixture();
    try {
      const result = run(f, { apiState: 'tools-missing' });
      assert.notStrictEqual(result.status, 0);
      assert.match(output(result, f), /lacks timeout or flock/);
      assert.doesNotMatch(log(f).join('\n'), /flock -n/);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe('run-care-closure.sh worker execution', function() {
  for (const [apiState, expectedStatus] of [
    ['healthy', 0],
    ['worker-failed', 2],
    ['worker-timeout', 124],
    ['lock-busy', 1]
  ]) {
    it(`executes existing worker and preserves ${apiState} status`, function() {
      const f = fixture();
      try {
        const result = run(f, { apiState });
        assert.strictEqual(result.status, expectedStatus, output(result, f));
        const joined = log(f).join('\n');
        assert.match(joined, /exec api-fixed-id/);
        assert.match(joined, /flock -n \/tmp\/care-closure-worker\.lock/);
        assert.match(joined, /timeout --signal=TERM --kill-after=5s 90s node --max-old-space-size=128 \/opt\/cboard-api\/scripts\/runCareClosureWorker\.js/);
        assert.doesNotMatch(joined, /compose (build|up|run)/);
        assert.doesNotMatch(output(result, f), /do-not-print-this|worker:secret/);
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });
  }
});

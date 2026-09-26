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

if (!bash) throw new Error('Git Bash is required for Care initialization shell tests');

const sourceRoot = path.resolve(__dirname, '../../deploy');
const sourceScript = path.join(sourceRoot, 'scripts', 'initialize-care.sh');

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function toGitPath(file) {
  const normalized = file.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized)) return `/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
  return normalized;
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cboard-care-init-test-'));
  const bin = path.join(root, 'bin');
  const scripts = path.join(root, 'deploy', 'scripts');
  const keyFile = path.join(root, 'care-mongo-key');
  const environment = path.join(root, 'deploy', '.env.care');
  const log = path.join(root, 'docker.log');
  const bashEnv = path.join(root, 'bash.env');
  fs.mkdirSync(bin);
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(keyFile, 'synthetic mongo key\n');
  fs.chmodSync(keyFile, 0o400);
  fs.writeFileSync(log, '');
  // BASH_ENV makes the Linux permission metadata shim apply even when Git
  // Bash resolves its own stat.exe before the fixture PATH entry.
  fs.writeFileSync(bashEnv, `export PATH="$FAKE_BIN:$PATH"
stat() {
  case "$*" in
    *"%a"*) echo 400 ;;
    *"%u"*) echo 0 ;;
    *) return 2 ;;
  esac
}
`);
  fs.writeFileSync(environment, [
    `DEPLOYMENT_PROJECT_NAME=${options.project || 'cboard-care-test'}`,
    'CARE_COLLABORATION_ENABLED=true',
    'CARE_NEXT_ENABLED=true',
    'CARE_LIFECYCLE_TRANSACTIONS_ENABLED=true',
    'MONGO_URL=mongodb://root:password@mongo:27017/care?replicaSet=care-rs',
    `CARE_MONGO_KEY_FILE=${toGitPath(keyFile)}`,
    ''
  ].join('\n'));
  for (const name of ['initialize-care.sh', 'docker-runtime.sh', 'read-deployment-env.sh']) {
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
      CARE_MONGO_KEY_FILE) printf '%s\\n' \"CARE_MONGO_KEY_FILE=\${FAKE_KEY_FILE}\" ;;
      CARE_COLLABORATION_ENABLED|CARE_NEXT_ENABLED|CARE_LIFECYCLE_TRANSACTIONS_ENABLED) printf '%s\\n' \"\${field}=true\" ;;
      MONGO_URL) printf '%s\\n' 'MONGO_URL=mongodb://root:password@mongo:27017/care?replicaSet=care-rs' ;;
      *) exit 1 ;;
    esac
  done
  exit 0
fi
if [[ "\${1:-}" == "-e" ]]; then
  key="\${5:-}"
  case "\${key}" in
    DEPLOYMENT_PROJECT_NAME) printf '%s' "\${FAKE_PROJECT_NAME}" ;;
    CARE_MONGO_KEY_FILE) printf '%s' "\${FAKE_KEY_FILE}" ;;
    CARE_COLLABORATION_ENABLED|CARE_NEXT_ENABLED|CARE_LIFECYCLE_TRANSACTIONS_ENABLED) printf 'true' ;;
    '') [[ "\${FAKE_REPLICA_VALID:-true}" == true ]] ;;
    *) exit 1 ;;
  esac
  exit 0
fi
# The deployment checker itself is stubbed: this test targets shell ordering and guards.
exit 0
`);

  writeExecutable(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  // Git Bash on Windows does not expose Linux mode/owner metadata. Keep the
  // shell contract deterministic with a fixture-only stat shim.
  const statShim = `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *"%a"*) echo 400 ;;
  *"%u"*) echo 0 ;;
  *) exit 2 ;;
esac
`;
  writeExecutable(path.join(bin, 'stat'), statShim);
  writeExecutable(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ "\${1:-}" == "info" ]]; then exit 0; fi
if [[ "$*" == *"ps -aq --filter"* ]]; then
  if [[ "\${FAKE_RESOURCE_STATE:-}" == "inventory-error" ]]; then exit 17; fi
  if [[ "\${FAKE_RESOURCE_STATE:-}" == "existing-container" ]]; then echo care-api; fi
  exit 0
fi
if [[ "$*" == *"volume ls -q --filter"* && "$*" == *"label=com.docker.compose.project"* ]]; then
  if [[ "\${FAKE_RESOURCE_STATE:-}" == "inventory-error" ]]; then exit 17; fi
  if [[ "\${FAKE_RESOURCE_STATE:-}" == "existing-labeled-volume" ]]; then echo care-volume; fi
  exit 0
fi
if [[ "$*" == *"volume ls -q --filter"* && "$*" == *"name=^"* ]]; then
  if [[ "\${FAKE_RESOURCE_STATE:-}" == "inventory-error" ]]; then exit 17; fi
  if [[ "\${FAKE_RESOURCE_STATE:-}" == "existing-volume" ]]; then echo care-volume; fi
  exit 0
fi
if [[ "$*" == *"network ls -q --filter"* ]]; then
  if [[ "\${FAKE_RESOURCE_STATE:-}" == "inventory-error" ]]; then exit 17; fi
  if [[ "\${FAKE_RESOURCE_STATE:-}" == "existing-network" ]]; then echo care-network; fi
  exit 0
fi
if [[ "$*" == *"config --quiet"* ]]; then exit 0; fi
if [[ "$*" == *"build api"* ]]; then exit 0; fi
if [[ "$*" == *"--entrypoint id mongo"* ]]; then
  stat -c '%u' "$FAKE_KEY_FILE"
  exit 0
fi
if [[ "$*" == *"--entrypoint sh api"* ]]; then exit 0; fi
if [[ "$*" == *"exec -T mongo"* ]]; then
  if [[ "$*" == *"rs.initiate"* && "\${FAKE_MONGO_STATE:-ready}" == "mongo-failure" ]]; then exit 17; fi
  exit 0
fi
if [[ "$*" == *"up -d --no-deps mongo"* ]]; then exit 0; fi
if [[ "$*" == *"up -d --no-deps --wait --wait-timeout 90 api"* ]]; then
  if [[ "\${FAKE_MONGO_STATE:-ready}" == "api-failure" ]]; then exit 17; fi
  exit 0
fi
echo "unexpected docker command: $*" >&2
exit 19
`);

  return {
    root,
    bin,
    fakeBin: toGitPath(bin),
    environment,
    keyFile: toGitPath(keyFile),
    log,
    bashEnv,
    script: path.join(scripts, 'initialize-care.sh'),
    project: options.project || 'cboard-care-test'
  };
}

function run(f, args = ['--initialize-empty'], options = {}) {
  return spawnSync(bash, [toGitPath(f.script), toGitPath(f.environment), ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    env: {
      ...process.env,
      FAKE_DOCKER_LOG: f.log,
      FAKE_KEY_FILE: f.keyFile,
      FAKE_PROJECT_NAME: f.project,
      FAKE_RESOURCE_STATE: options.resourceState || '',
      FAKE_MONGO_STATE: options.mongoState || 'ready',
      FAKE_REPLICA_VALID: options.replicaValid === false ? 'false' : 'true',
      BASH_ENV: f.bashEnv,
      FAKE_BIN: f.fakeBin,
      PATH: `${f.bin}${path.delimiter}${process.env.PATH || ''}`
    }
  });
}

function dockerLog(f) {
  return fs.readFileSync(f.log, 'utf8').trim().split(/\r?\n/).filter(Boolean);
}

function resultText(result, f) {
  return `${result.stdout || ''}\n${result.stderr || ''}\n${result.error ? result.error.stack || result.error.message : ''}\nDocker log:\n${fs.readFileSync(f.log, 'utf8')}`;
}

function assertNoCompose(f) {
  assert.doesNotMatch(dockerLog(f).join('\n'), /compose /);
}

describe('initialize-care.sh safety gates', function() {
  it('requires the explicit empty-initialization flag before touching Docker', function() {
    const f = fixture();
    try {
      const result = run(f, []);
      assert.notStrictEqual(result.status, 0);
      assert.match(resultText(result, f), /--initialize-empty/);
      assert.strictEqual(fs.readFileSync(f.log, 'utf8'), '');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('rejects a non-dedicated project before Compose', function() {
    const f = fixture({ project: 'cboard-api-production' });
    try {
      const result = run(f);
      assert.notStrictEqual(result.status, 0);
      assert.match(resultText(result, f), /dedicated cboard-care/);
      assertNoCompose(f);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('rejects an existing labeled container before Compose', function() {
    const f = fixture();
    try {
      const result = run(f, ['--initialize-empty'], { resourceState: 'existing-container' });
      assert.notStrictEqual(result.status, 0);
      assert.match(resultText(result, f), /Existing project resources/);
      assert.match(dockerLog(f).join('\n'), /ps -aq --filter/);
      assertNoCompose(f);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('rejects a same-name unlabelled volume from the explicit name inventory', function() {
    const f = fixture();
    try {
      const result = run(f, ['--initialize-empty'], { resourceState: 'existing-volume' });
      assert.notStrictEqual(result.status, 0);
      assert.match(resultText(result, f), /target volume already exists/);
      const log = dockerLog(f).join('\n');
      assert.match(log, /volume ls -q --filter name=\^cboard-care-test_/);
      assertNoCompose(f);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('rejects a same-name unlabelled network', function() {
    const f = fixture();
    try {
      const result = run(f, ['--initialize-empty'], { resourceState: 'existing-network' });
      assert.notStrictEqual(result.status, 0);
      assert.match(resultText(result, f), /target network already exists/);
      const log = dockerLog(f).join('\n');
      assert.match(log, /network ls -q --filter name=\^cboard-care-test_/);
      assertNoCompose(f);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('fails closed when resource inventory cannot be queried', function() {
    const f = fixture();
    try {
      const result = run(f, ['--initialize-empty'], { resourceState: 'inventory-error' });
      assert.notStrictEqual(result.status, 0);
      assert.doesNotMatch(resultText(result, f), /target volume|target network/);
      assertNoCompose(f);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('honors the restore security hold before resources are inspected', function() {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.root, 'deploy', `.restore-security-review-required.${f.project}`), 'review required');
      const result = run(f);
      assert.notStrictEqual(result.status, 0);
      assert.match(resultText(result, f), /Restore security review required/);
      assertNoCompose(f);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe('initialize-care.sh orchestration', function() {
  this.timeout(30000);
  it('runs the fresh path in build, UID, media-permission, Mongo, primary, transaction, API order without Caddy', function() {
    const f = fixture();
    try {
      const result = run(f);
      assert.strictEqual(result.status, 0, resultText(result, f));
      const log = dockerLog(f);
      const at = fragment => log.findIndex(line => line.includes(fragment));
      const order = [
        'build api',
        '--entrypoint id mongo',
        '--cap-add CHOWN --entrypoint sh api',
        'up -d --no-deps mongo',
        'exec -T mongo',
        'rs.initiate',
        'isWritablePrimary',
        'care_deployment_probe_',
        'up -d --no-deps --wait --wait-timeout 90 api'
      ].map(at);
      for (let i = 1; i < order.length; i += 1) assert.ok(order[i - 1] >= 0 && order[i] > order[i - 1], `${order[i - 1]} !< ${order[i]}`);
      const permission = log.find(line => line.includes('--cap-add CHOWN --entrypoint sh api'));
      assert.match(permission, /chmod 700 \/data\/care-media && chown node:node \/data\/care-media/);
      assert.doesNotMatch(log.join('\n'), /caddy/i);
      assert.doesNotMatch(log.filter(line => line.includes('up -d --no-deps --wait')).join('\n'), /cap-add/);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('does not start the API when Mongo initialization fails', function() {
    const f = fixture();
    try {
      const result = run(f, ['--initialize-empty'], { mongoState: 'mongo-failure' });
      assert.notStrictEqual(result.status, 0);
      const log = dockerLog(f).join('\n');
      assert.match(log, /rs\.initiate/, resultText(result, f));
      assert.doesNotMatch(log, /up -d --no-deps --wait --wait-timeout 90 api/);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
});

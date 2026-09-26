'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const bash = process.platform === 'win32'
  ? ['D:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/bin/bash.exe'].find(p => fs.existsSync(p))
  : 'bash';
const unix = p => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());

describe('Care backup shell orchestration', function() {
  this.timeout(30000);
  for (const mode of ['success', 'busy', 'multiple', 'failed', 'sudo-only']) {
    it(`holds the exclusive maintenance lock and propagates ${mode}`, function() {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'care-backup-shell-'));
      try {
        const scripts = path.join(root, 'deploy', 'scripts');
        const bin = path.join(root, 'bin');
        fs.mkdirSync(scripts, { recursive: true }); fs.mkdirSync(bin);
        for (const name of ['backup-care.sh', 'docker-runtime.sh', 'read-deployment-env.sh']) {
          fs.copyFileSync(path.resolve(__dirname, '../../deploy/scripts', name), path.join(scripts, name));
        }
        const log = path.join(root, 'calls'); fs.writeFileSync(log, '');
        const envFile = path.join(root, 'test.env'); fs.writeFileSync(envFile, 'synthetic-only');
        const bashEnv = path.join(root, 'bash.env');
        fs.writeFileSync(bashEnv, 'export PATH="$FAKE_BIN:$PATH"\n');
        const write = (name, body) => fs.writeFileSync(path.join(bin, name), '#!/usr/bin/env bash\nset -e\n' + body, { mode: 0o755 });
        write('node', `if [[ "\${1:-}" == *readDeploymentEnvironment.js ]]; then
case "\${5:-}" in
DEPLOYMENT_PROJECT_NAME) printf 'DEPLOYMENT_PROJECT_NAME=cboard-care-test\\n' ;;
CARE_MONGO_KEY_FILE) printf 'CARE_MONGO_KEY_FILE=/synthetic/mongo.key\\n' ;;
*) exit 9 ;;
esac
exit 0
fi
case "\${5:-}" in
DEPLOYMENT_PROJECT_NAME) echo cboard-care-test ;;
CARE_MONGO_KEY_FILE) echo /synthetic/mongo.key ;;
*) exit 9 ;;
esac\n`);
        write('flock', 'echo "lock $*" >> "$FAKE_LOG"\n[[ "$FAKE_MODE" != busy ]]\n');
        write('docker', `echo "docker $*" >> "$FAKE_LOG"
if [[ "$1" == info ]]; then [[ "$FAKE_MODE" != sudo-only ]]; exit; fi
if [[ "$FAKE_MODE" == multiple ]]; then printf '%s\\n%s\\n' '${'a'.repeat(64)}' '${'b'.repeat(64)}'; exit 0; fi
if [[ "$*" == *service=api* ]]; then echo '${'a'.repeat(64)}'; else echo '${'b'.repeat(64)}'; fi\n`);
        write('python3', 'echo "backup-callable" >> "$FAKE_LOG"\n[[ "$FAKE_MODE" != failed ]]\n');
        write('sudo', 'echo "sudo-called" >> "$FAKE_LOG"\nexit 0\n');
        const result = spawnSync(bash, [unix(path.join(scripts, 'backup-care.sh')), unix(envFile), unix(path.join(root, 'data')), unix(path.join(root, 'keys'))], {
          encoding: 'utf8', timeout: 20000, windowsHide: true,
          env: { ...process.env, BASH_ENV: unix(bashEnv), FAKE_BIN: unix(bin), FAKE_LOG: unix(log), FAKE_MODE: mode }
        });
        if (result.error) throw result.error;
        const calls = fs.readFileSync(log, 'utf8');
        assert.match(calls, /^lock --nonblock --exclusive /);
        assert.equal(result.status === 0, mode === 'success', result.stderr);
        if (mode === 'busy') assert.doesNotMatch(calls, /docker|backup-callable/);
        if (mode === 'multiple') assert.doesNotMatch(calls, /backup-callable/);
        if (mode === 'sudo-only') {
          assert.match(result.stderr, /Direct Docker access is required/);
          assert.doesNotMatch(calls, /sudo-called|backup-callable/);
        }
        if (mode === 'success' || mode === 'failed') assert.match(calls, /backup-callable/);
        assert.doesNotMatch(calls, /docker (start|stop|run|compose)/);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }
});

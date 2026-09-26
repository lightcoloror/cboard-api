'use strict';
// Uses the installed Compose parser only: no Docker daemon, containers or images.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

describe('Care merged Compose configuration', function() {
  this.timeout(30000);
  it('preserves base isolation while supplying replica authentication and persistent private media', function() {
    const root = path.resolve(__dirname, '../..');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'care-compose-config-'));
    try {
      const env = path.join(temporary, 'synthetic.env');
      fs.writeFileSync(env, [
        'API_DOMAIN=synthetic.invalid', 'ACME_EMAIL=synthetic@synthetic.invalid',
        'MONGO_USERNAME=synthetic', 'MONGO_PASSWORD=synthetic-only',
        'MONGO_URL=mongodb://synthetic:synthetic-only@mongo:27017/synthetic?authSource=admin&replicaSet=care-rs',
        'API_SESSION_SECRET=synthetic-only', 'JWT_SECRET=synthetic-only',
        `CARE_MONGO_KEY_FILE=${path.join(temporary, 'unused-key').replace(/\\/g, '/')}`,
        'BIND_ADDRESS=127.0.0.1'
      ].join('\n'));
      const result = execFileSync('docker', [
        'compose', '--project-name', 'cboard-care-config-test', '--env-file', env,
        '-f', path.join(root, 'deploy/docker-compose.production.yml'),
        '-f', path.join(root, 'deploy/docker-compose.care.yml'),
        'config', '--format', 'json'
      ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      const model = JSON.parse(result);
      const { mongo, api } = model.services;
      assert.ok(!mongo.ports || mongo.ports.length === 0);
      assert.ok(!api.ports || api.ports.length === 0);
      assert.equal(mongo.volumes.filter(v => v.target === '/data/db').length, 1);
      const key = mongo.volumes.find(v => v.target === '/run/secrets/care-mongo-key');
      assert.equal(key.read_only, true);
      assert.equal(key.bind.create_host_path, false);
      assert.ok(mongo.command.includes('care-rs'));
      assert.ok(mongo.healthcheck.test.join(' ').includes('isWritablePrimary'));
      assert.equal(api.environment.CARE_MEDIA_ROOT, '/data/care-media');
      assert.equal(api.environment.CARE_CLOSURE_WORKER_ENABLED, 'false');
      assert.equal(api.environment.CARE_PUBLIC_TRIAL_ENABLED, 'false');
      assert.ok(api.volumes.some(v => v.type === 'volume' && v.target === '/data/care-media'));
      assert.ok(api.cap_drop.includes('ALL'));
      assert.equal(api.read_only, true);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});

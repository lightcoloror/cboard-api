const { spawnSync } = require('child_process');

const mochaPath = require.resolve('mocha/bin/mocha');
const cliArgs = process.argv.slice(2);
const unitOnly = cliArgs.includes('--unit');
const forwardedArgs = cliArgs.filter(argument => argument !== '--unit');
const mochaArgs = [
  mochaPath,
  unitOnly ? './test/controllers/**/*.unit.js' : './test/controllers',
  '--exit',
  ...forwardedArgs
];

const result = spawnSync(process.execPath, mochaArgs, {
  env: { ...process.env, NODE_ENV: 'test' },
  stdio: 'inherit'
});

if (result.error) {
  console.error('Unable to start the controller test suite:', result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);

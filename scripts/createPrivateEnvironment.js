'use strict';

const fs = require('fs');
const path = require('path');
const {
  buildProductionEnvironment,
  replaceEnvironmentValues,
  writeExclusive
} = require('./createProductionEnvironment');
const { validateProductionDeployment } = require('./checkProductionDeployment');

const projectRoot = path.resolve(__dirname, '..');
const defaultTemplatePath = path.join(
  projectRoot,
  'deploy/.env.production.example'
);
const defaultOutputPath = path.join(projectRoot, 'deploy/.env.private');

function buildPrivateEnvironment({ template, secretFactory }) {
  const environment = buildProductionEnvironment({
    template,
    domain: 'private.localhost',
    email: 'private-predeploy@localhost.invalid',
    secretFactory
  });

  return replaceEnvironmentValues(environment, {
    BIND_ADDRESS: '127.0.0.1',
    HTTP_PORT: '18080',
    HTTPS_PORT: '18443',
    CADDYFILE: './Caddyfile.local',
    DEPLOYMENT_PROJECT_NAME: 'cboard-api-private',
    DEBIAN_MIRROR: 'http://mirrors.cloud.tencent.com/debian',
    DEBIAN_SECURITY_MIRROR: 'http://mirrors.cloud.tencent.com/debian-security',
    CBOARD_APP_URL: ''
  });
}

function runCli() {
  const requestedOutput = process.argv
    .slice(2)
    .find(arg => !arg.startsWith('--'));
  const outputPath = requestedOutput
    ? path.resolve(process.cwd(), requestedOutput)
    : defaultOutputPath;
  const environment = buildPrivateEnvironment({
    template: fs.readFileSync(defaultTemplatePath, 'utf8')
  });

  try {
    writeExclusive(outputPath, environment);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      console.error(
        `Refusing to overwrite existing private environment: ${outputPath}`
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const errors = validateProductionDeployment({
    environmentPath: outputPath,
    privateMode: true
  });
  if (errors.length) {
    fs.rmSync(outputPath, { force: true });
    throw new Error(
      `Generated private environment failed validation: ${errors.join(' ')}`
    );
  }

  console.log(
    `Private deployment environment created and validated at ${outputPath}. Secrets were not printed.`
  );
}

if (require.main === module) runCli();

module.exports = {
  buildPrivateEnvironment
};

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  validateProductionDeployment
} = require('./checkProductionDeployment');

const projectRoot = path.resolve(__dirname, '..');
const defaultTemplatePath = path.join(
  projectRoot,
  'deploy/.env.production.example'
);
const defaultOutputPath = path.join(projectRoot, 'deploy/.env.production');

function replaceEnvironmentValues(source, values) {
  const remaining = new Set(Object.keys(values));
  const output = source
    .split(/\r?\n/)
    .map(line => {
      const separator = line.indexOf('=');
      if (separator < 1 || line.trimStart().startsWith('#')) return line;
      const key = line.slice(0, separator).trim();
      if (!remaining.has(key)) return line;
      remaining.delete(key);
      return `${key}=${values[key]}`;
    })
    .join('\n');

  if (remaining.size) {
    throw new Error(
      `Production environment template is missing: ${[...remaining].join(', ')}`
    );
  }
  return `${output.trimEnd()}\n`;
}

function validateInputs({ domain, email }) {
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
      domain || ''
    )
  ) {
    throw new Error(
      'Domain must be a hostname such as api.example.com without a scheme or path.'
    );
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) {
    throw new Error('Email must be a valid ACME contact address.');
  }
}

function createSecretFactory() {
  return () => crypto.randomBytes(36).toString('base64url');
}

function buildProductionEnvironment({
  template,
  domain,
  email,
  secretFactory = createSecretFactory()
}) {
  validateInputs({ domain, email });
  const mongoPassword = secretFactory('mongo');
  const sessionSecret = secretFactory('session');
  const jwtSecret = secretFactory('jwt');
  const imageProxySecret = secretFactory('pictogram-proxy');
  const generated = [
    mongoPassword,
    sessionSecret,
    jwtSecret,
    imageProxySecret
  ];

  if (
    generated.some(secret => !/^[A-Za-z0-9._~-]{32,}$/.test(secret)) ||
    new Set(generated).size !== generated.length
  ) {
    throw new Error(
      'Secret generation must return unique URL-safe values of at least 32 characters.'
    );
  }

  return replaceEnvironmentValues(template, {
    API_DOMAIN: domain,
    ACME_EMAIL: email,
    MONGO_PASSWORD: mongoPassword,
    MONGO_URL:
      `mongodb://cboard:${mongoPassword}@mongo:27017/cboard-api` +
      '?authSource=admin',
    API_SESSION_SECRET: sessionSecret,
    JWT_SECRET: jwtSecret,
    PICTOGRAM_IMAGE_PROXY_SECRET: imageProxySecret
  });
}

function parseArguments(argv) {
  const valueAfter = flag => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const positional = argv.filter(argument => !argument.startsWith('--'));
  return {
    domain: valueAfter('--domain') || positional[0],
    email: valueAfter('--email') || positional[1],
    outputPath: valueAfter('--output') || positional[2]
  };
}

function writeExclusive(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, contents, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function runCli() {
  const { domain, email, outputPath } = parseArguments(process.argv.slice(2));
  if (!domain || !email) {
    console.error(
      'Usage: npm run prepare:production-env -- api.example.com admin@example.com [output-path]'
    );
    process.exitCode = 1;
    return;
  }

  const resolvedOutput = outputPath
    ? path.resolve(process.cwd(), outputPath)
    : defaultOutputPath;
  const environment = buildProductionEnvironment({
    template: fs.readFileSync(defaultTemplatePath, 'utf8'),
    domain,
    email
  });

  try {
    writeExclusive(resolvedOutput, environment);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      console.error(
        `Refusing to overwrite existing production environment: ${resolvedOutput}`
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const errors = validateProductionDeployment({
    environmentPath: resolvedOutput
  });
  if (errors.length) {
    fs.rmSync(resolvedOutput, { force: true });
    throw new Error(
      `Generated environment failed validation: ${errors.join(' ')}`
    );
  }

  console.log(
    `Production environment created and validated at ${resolvedOutput}. Secrets were not printed.`
  );
}

if (require.main === module) runCli();

module.exports = {
  buildProductionEnvironment,
  parseArguments,
  replaceEnvironmentValues,
  validateInputs,
  writeExclusive
};

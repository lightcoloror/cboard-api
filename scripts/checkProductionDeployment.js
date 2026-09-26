'use strict';

const fs = require('fs');
const path = require('path');
const { configuredEmailAppOrigin } = require('../api/helpers/emailLinkOrigin');
const { validateCareDeploymentConfiguration } = require('./checkCareDeploymentConfiguration');

const projectRoot = path.resolve(__dirname, '..');
const deployRoot = path.join(projectRoot, 'deploy');

function validateDeploymentEmailConfiguration(env) {
  const present = key => typeof env[key] === 'string' && Boolean(env[key].trim());
  const required = env.CARE_PUBLIC_TRIAL_ENABLED === 'true';
  if (!required && !['EMAIL_FROM', 'SENDGRID_API_KEY', 'AUTH_EMAIL_APP_URL'].some(present)) return [];
  const errors = [];
  for (const key of ['EMAIL_FROM', 'SENDGRID_API_KEY']) {
    if (!present(key)) errors.push(`Registration email requires ${key}.`);
  }
  if (present('EMAIL_FROM') && /[\r\n]/.test(env.EMAIL_FROM)) {
    errors.push('EMAIL_FROM must not contain line breaks.');
  }
  const placeholder = /replace|change[-_ ]?me|example\.com|your[-_]/i;
  ['EMAIL_FROM', 'SENDGRID_API_KEY'].forEach(key => {
    if (present(key) && placeholder.test(env[key])) {
      errors.push(`${key} still contains a placeholder value.`);
    }
  });
  if (!configuredEmailAppOrigin({
    env: 'production', AUTH_EMAIL_APP_URL: env.AUTH_EMAIL_APP_URL,
    CBOARD_APP_URL: env.CBOARD_APP_URL
  })) errors.push('Registration email requires an HTTPS application origin without credentials, path, query or fragment.');
  return errors;
}

function parseEnv(source) {
  return source.split(/\r?\n/).reduce((values, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return values;
    const separator = trimmed.indexOf('=');
    if (separator < 1) return values;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
    return values;
  }, {});
}

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function validateProductionDeployment({
  environmentPath,
  exampleMode = false,
  privateMode = false
} = {}) {
  const envPath = environmentPath
    ? path.resolve(environmentPath)
    : path.join(
        deployRoot,
        exampleMode ? '.env.production.example' : '.env.production'
      );
  const errors = [];
  const requiredFiles = [
    'Dockerfile',
    '.dockerignore',
    'deploy/docker-compose.production.yml',
    'deploy/Caddyfile',
    'deploy/Caddyfile.local',
    'deploy/scripts/bootstrap-lighthouse.sh',
    'deploy/scripts/deploy.sh',
    'deploy/scripts/deploy-private.sh',
    'deploy/scripts/docker-runtime.sh',
    'deploy/scripts/health-check.sh',
    'deploy/scripts/health-check-private.sh',
    'deploy/scripts/prepare-private-env.sh',
    'deploy/scripts/verify-private-persistence.sh',
    'deploy/scripts/backup-mongo.sh',
    'deploy/scripts/restore-mongo.sh',
    'scripts/createPrivateEnvironment.js'
  ];

  requiredFiles.forEach(relativePath => {
    if (!fs.existsSync(path.join(projectRoot, relativePath))) {
      errors.push(`Missing deployment file: ${relativePath}`);
    }
  });

  if (!fs.existsSync(envPath)) {
    errors.push(
      `Missing environment file: ${envPath}. Start from deploy/.env.production.example.`
    );
  }

  const env = fs.existsSync(envPath)
    ? parseEnv(fs.readFileSync(envPath, 'utf8'))
    : {};
  errors.push(...validateDeploymentEmailConfiguration(env));
  errors.push(...validateCareDeploymentConfiguration(env));
  const requiredKeys = [
    'API_DOMAIN',
    'ACME_EMAIL',
    'MONGO_USERNAME',
    'MONGO_PASSWORD',
    'MONGO_URL',
    'API_SESSION_SECRET',
    'JWT_SECRET',
    'DEPLOYMENT_PROJECT_NAME',
    'PHONE_VERIFICATION_REQUIRED',
    'COMMUNICATION_ENHANCEMENT_RATE_LIMIT_ENABLED',
    'COMMUNICATION_ENHANCEMENT_POINTS_PER_MINUTE',
    'COMMUNICATION_ENHANCEMENT_MONTHLY_POINTS',
    'COMMUNICATION_AI_TOKEN_QUOTA_ENABLED',
    'COMMUNICATION_AI_MONTHLY_TOKEN_QUOTA',
    'COMMUNICATION_AI_TEXT_TOKEN_RESERVATION',
    'COMMUNICATION_AI_IMAGE_TOKEN_RESERVATION'
  ];

  requiredKeys.forEach(key => {
    if (!env[key]) errors.push(`Missing required environment key: ${key}`);
  });

  if (privateMode) {
    if (env.BIND_ADDRESS !== '127.0.0.1') {
      errors.push('Private deployment must bind only to 127.0.0.1.');
    }
    if (env.CADDYFILE !== './Caddyfile.local') {
      errors.push('Private deployment must use deploy/Caddyfile.local.');
    }
    if (env.DEPLOYMENT_PROJECT_NAME !== 'cboard-api-private') {
      errors.push(
        'Private deployment must use the isolated cboard-api-private Compose project.'
      );
    }
    if (
      env.DEBIAN_MIRROR !== 'http://mirrors.cloud.tencent.com/debian' ||
      env.DEBIAN_SECURITY_MIRROR !==
        'http://mirrors.cloud.tencent.com/debian-security'
    ) {
      errors.push(
        'Tencent private deployment must use the official Tencent Debian mirrors.'
      );
    }
    ['HTTP_PORT', 'HTTPS_PORT'].forEach(key => {
      const value = Number(env[key]);
      if (!Number.isInteger(value) || value < 1024 || value > 65535) {
        errors.push(
          `${key} must be a private high port between 1024 and 65535.`
        );
      }
    });
    if (env.HTTP_PORT && env.HTTPS_PORT && env.HTTP_PORT === env.HTTPS_PORT) {
      errors.push('Private HTTP_PORT and HTTPS_PORT must be different.');
    }
  }

  if (
    env.API_DOMAIN &&
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
      env.API_DOMAIN
    )
  ) {
    errors.push(
      'API_DOMAIN must be a hostname without a scheme, path, or port.'
    );
  }

  if (env.ACME_EMAIL && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env.ACME_EMAIL)) {
    errors.push('ACME_EMAIL must be a valid contact email address.');
  }

  if (env.MONGO_USERNAME && !/^[A-Za-z0-9._~-]+$/.test(env.MONGO_USERNAME)) {
    errors.push('MONGO_USERNAME must contain only URL-safe characters.');
  }

  if (
    env.MONGO_PASSWORD &&
    !/^[A-Za-z0-9._~-]{24,}$/.test(env.MONGO_PASSWORD)
  ) {
    errors.push('MONGO_PASSWORD must be at least 24 characters and URL-safe.');
  }

  const azureConfigured = Boolean(env.AZURE_STORAGE_CONNECTION_STRING);
  const privateContainerConfigured = Boolean(
    env.PRIVATE_LIBRARY_CONTAINER_NAME
  );
  if (azureConfigured !== privateContainerConfigured) {
    errors.push(
      'Azure private library requires both AZURE_STORAGE_CONNECTION_STRING and PRIVATE_LIBRARY_CONTAINER_NAME.'
    );
  }
  if (
    privateContainerConfigured &&
    !/^(?!.*--)[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(
      env.PRIVATE_LIBRARY_CONTAINER_NAME
    )
  ) {
    errors.push(
      'PRIVATE_LIBRARY_CONTAINER_NAME must be 3-63 lowercase letters, numbers, or single hyphens, and start and end with a letter or number.'
    );
  }

  if (env.COMMUNICATION_ENHANCEMENT_RATE_LIMIT_ENABLED !== 'true') {
    errors.push(
      'COMMUNICATION_ENHANCEMENT_RATE_LIMIT_ENABLED must be true in production.'
    );
  }
  if (env.COMMUNICATION_AI_TOKEN_QUOTA_ENABLED !== 'true') {
    errors.push(
      'COMMUNICATION_AI_TOKEN_QUOTA_ENABLED must be true in production.'
    );
  }

  if (!['true', 'false'].includes(env.PHONE_VERIFICATION_REQUIRED)) {
    errors.push('PHONE_VERIFICATION_REQUIRED must be true or false.');
  }
  if (env.PHONE_VERIFICATION_REQUIRED === 'true') {
    const requiredPhoneKeys = [
      'PHONE_VERIFICATION_PROVIDER',
      'PHONE_VERIFICATION_HASH_SECRET',
      'PHONE_VERIFICATION_TENCENTCLOUD_SECRET_ID',
      'PHONE_VERIFICATION_TENCENTCLOUD_SECRET_KEY',
      'PHONE_VERIFICATION_TENCENTCLOUD_SMS_SDK_APP_ID',
      'PHONE_VERIFICATION_TENCENTCLOUD_SMS_SIGN_NAME',
      'PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_ID',
      'PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_PARAMETERS'
    ];
    requiredPhoneKeys.forEach(key => {
      if (!env[key]) {
        errors.push(`Missing required phone verification key: ${key}`);
      }
    });
    if (env.PHONE_VERIFICATION_PROVIDER !== 'tencentcloud') {
      errors.push(
        'PHONE_VERIFICATION_PROVIDER must be tencentcloud when phone verification is enabled.'
      );
    }
    if (
      env.PHONE_VERIFICATION_HASH_SECRET &&
      env.PHONE_VERIFICATION_HASH_SECRET.length < 32
    ) {
      errors.push(
        'PHONE_VERIFICATION_HASH_SECRET must contain at least 32 characters.'
      );
    }
    if (
      env.PHONE_VERIFICATION_HASH_SECRET &&
      [env.API_SESSION_SECRET, env.JWT_SECRET].includes(
        env.PHONE_VERIFICATION_HASH_SECRET
      )
    ) {
      errors.push(
        'PHONE_VERIFICATION_HASH_SECRET must be independent from session and JWT secrets.'
      );
    }
    if (
      env.PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_PARAMETERS &&
      !/^(?:code|minutes)(?:,(?:code|minutes))?$/.test(
        env.PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_PARAMETERS
      )
    ) {
      errors.push(
        'PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_PARAMETERS must contain only code and optional minutes.'
      );
    }
  }

  const dialectAsrProvider = String(
    env.COMMUNICATION_DIALECT_ASR_PROVIDER || ''
  )
    .trim()
    .toLowerCase();
  if (
    dialectAsrProvider &&
    !['tencentcloud', 'volcengine'].includes(dialectAsrProvider)
  ) {
    errors.push(
      'COMMUNICATION_DIALECT_ASR_PROVIDER must be empty, tencentcloud, or volcengine.'
    );
  }
  if (
    dialectAsrProvider === 'tencentcloud' &&
    (!env.COMMUNICATION_TENCENTCLOUD_ASR_SECRET_ID ||
      !env.COMMUNICATION_TENCENTCLOUD_ASR_SECRET_KEY)
  ) {
    errors.push('Tencent Cloud dialect ASR requires both server credentials.');
  }
  if (dialectAsrProvider === 'volcengine') {
    const hasNewCredentials = Boolean(env.VOLCENGINE_ASR_API_KEY);
    const hasLegacyCredentials = Boolean(
      env.VOLCENGINE_ASR_APP_KEY && env.VOLCENGINE_ASR_ACCESS_KEY
    );
    if (!hasNewCredentials && !hasLegacyCredentials) {
      errors.push(
        'Volcengine dialect ASR requires an API key or complete legacy App-Key and Access-Key credentials.'
      );
    }
    if (
      env.VOLCENGINE_ASR_BASE_URL &&
      !/^https:\/\/[^/]+\//i.test(env.VOLCENGINE_ASR_BASE_URL)
    ) {
      errors.push('VOLCENGINE_ASR_BASE_URL must use HTTPS in production.');
    }
    if (
      env.VOLCENGINE_ASR_RESOURCE_ID &&
      env.VOLCENGINE_ASR_RESOURCE_ID !== 'volc.bigasr.auc_turbo'
    ) {
      errors.push(
        'VOLCENGINE_ASR_RESOURCE_ID must be volc.bigasr.auc_turbo for the flash recognition adapter.'
      );
    }
  }

  [
    ['COMMUNICATION_ENHANCEMENT_POINTS_PER_MINUTE', 1, 10000],
    ['COMMUNICATION_ENHANCEMENT_MONTHLY_POINTS', 1, 10000000],
    ['COMMUNICATION_AI_MONTHLY_TOKEN_QUOTA', 1, 1000000000],
    ['COMMUNICATION_AI_TEXT_TOKEN_RESERVATION', 1, 1000000000],
    ['COMMUNICATION_AI_IMAGE_TOKEN_RESERVATION', 1, 1000000000]
  ].forEach(([key, minimum, maximum]) => {
    const value = Number(env[key]);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      errors.push(
        `${key} must be an integer between ${minimum} and ${maximum}.`
      );
    }
  });
  [
    'COMMUNICATION_AI_TEXT_TOKEN_RESERVATION',
    'COMMUNICATION_AI_IMAGE_TOKEN_RESERVATION'
  ].forEach(key => {
    if (
      Number.isInteger(Number(env[key])) &&
      Number.isInteger(Number(env.COMMUNICATION_AI_MONTHLY_TOKEN_QUOTA)) &&
      Number(env[key]) > Number(env.COMMUNICATION_AI_MONTHLY_TOKEN_QUOTA)
    ) {
      errors.push(
        `${key} must not exceed COMMUNICATION_AI_MONTHLY_TOKEN_QUOTA.`
      );
    }
  });

  if (env.MONGO_URL) {
    const expectedAuthority =
      `${encodeURIComponent(env.MONGO_USERNAME || '')}:` +
      `${encodeURIComponent(env.MONGO_PASSWORD || '')}@mongo:27017/`;
    let validMongoTarget = false;
    try {
      const uri = new URL(env.MONGO_URL);
      validMongoTarget = env.MONGO_URL.startsWith(`mongodb://${expectedAuthority}`) &&
        uri.protocol === 'mongodb:' && uri.hostname === 'mongo' && uri.port === '27017' &&
        !uri.hash && [...uri.searchParams.keys()].filter(key => key.toLowerCase() === 'authsource').length === 1 &&
        uri.searchParams.get('authSource') === 'admin';
    } catch (_) { /* Report only the fixed error below, never a credential URI. */ }
    if (!validMongoTarget) {
      errors.push(
        'MONGO_URL must use the configured credentials, internal mongo host, and authSource=admin.'
      );
    }
  }

  ['API_SESSION_SECRET', 'JWT_SECRET'].forEach(key => {
    if (env[key] && env[key].length < 32) {
      errors.push(`${key} must contain at least 32 characters.`);
    }
  });

  if (
    env.API_SESSION_SECRET &&
    env.JWT_SECRET &&
    env.API_SESSION_SECRET === env.JWT_SECRET
  ) {
    errors.push('API_SESSION_SECRET and JWT_SECRET must be independent.');
  }
  if (!exampleMode) {
    const placeholder = /replace|change[-_ ]?me|example\.com|your[-_]/i;
    const configuredKeys = [
      ...requiredKeys,
      'AZURE_STORAGE_CONNECTION_STRING',
      'PRIVATE_LIBRARY_CONTAINER_NAME',
      'PHONE_VERIFICATION_PROVIDER',
      'PHONE_VERIFICATION_HASH_SECRET',
      'PHONE_VERIFICATION_TENCENTCLOUD_SECRET_ID',
      'PHONE_VERIFICATION_TENCENTCLOUD_SECRET_KEY',
      'PHONE_VERIFICATION_TENCENTCLOUD_SMS_SDK_APP_ID',
      'PHONE_VERIFICATION_TENCENTCLOUD_SMS_SIGN_NAME',
      'PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_ID'
    ];
    configuredKeys.forEach(key => {
      if (env[key] && placeholder.test(env[key])) {
        errors.push(`${key} still contains a placeholder value.`);
      }
    });
  }

  const dockerfile = readProjectFile('Dockerfile');
  if (!dockerfile.includes('USER node')) {
    errors.push('Dockerfile must run the API as the non-root node user.');
  }
  if (!dockerfile.includes('yarn install --frozen-lockfile')) {
    errors.push(
      'Dockerfile must install production dependencies from yarn.lock.'
    );
  }
  if (
    !dockerfile.includes('python3') ||
    !dockerfile.includes('make') ||
    !dockerfile.includes('g++') ||
    !dockerfile.includes('DEBIAN_MIRROR') ||
    !dockerfile.includes('Acquire::ForceIPv4=true') ||
    !dockerfile.includes('ca-certificates')
  ) {
    errors.push(
      'Dockerfile dependency stage must support native addon source builds.'
    );
  }
  if (!dockerfile.includes('/health')) {
    errors.push('Dockerfile must health-check the public readiness endpoint.');
  }

  const dockerignore = readProjectFile('.dockerignore');
  if (!dockerignore.includes('.env.*')) {
    errors.push('.dockerignore must exclude environment files.');
  }

  const compose = readProjectFile('deploy/docker-compose.production.yml');
  if (!compose.includes('${BIND_ADDRESS:-0.0.0.0}')) {
    errors.push('Caddy host ports must support an explicit bind address.');
  }
  if (
    !compose.includes('DEBIAN_MIRROR') ||
    !compose.includes('DEBIAN_SECURITY_MIRROR')
  ) {
    errors.push('The API build must accept explicit Debian mirror arguments.');
  }
  if (/^\s*-\s*["']?\d+:27017/m.test(compose)) {
    errors.push('MongoDB must not publish port 27017 to the host.');
  }
  if (/^\s*-\s*["']?\d+:10010/m.test(compose)) {
    errors.push('The API must only be reachable through the HTTPS proxy.');
  }
  if (!compose.includes('PRIVATE_LIBRARY_CONTAINER_NAME')) {
    errors.push(
      'The API container must receive PRIVATE_LIBRARY_CONTAINER_NAME.'
    );
  }
  if (
    !compose.includes('COMMUNICATION_ENHANCEMENT_RATE_LIMIT_ENABLED') ||
    !compose.includes('COMMUNICATION_ENHANCEMENT_POINTS_PER_MINUTE') ||
    !compose.includes('COMMUNICATION_ENHANCEMENT_MONTHLY_POINTS')
  ) {
    errors.push(
      'The API container must receive communication enhancement limit settings.'
    );
  }
  if (
    !compose.includes('COMMUNICATION_AI_TOKEN_QUOTA_ENABLED') ||
    !compose.includes('COMMUNICATION_AI_MONTHLY_TOKEN_QUOTA') ||
    !compose.includes('COMMUNICATION_AI_TEXT_TOKEN_RESERVATION') ||
    !compose.includes('COMMUNICATION_AI_IMAGE_TOKEN_RESERVATION')
  ) {
    errors.push(
      'The API container must receive communication AI token quota settings.'
    );
  }
  if (
    !compose.includes('VOLCENGINE_ASR_API_KEY') ||
    !compose.includes('VOLCENGINE_ASR_APP_KEY') ||
    !compose.includes('VOLCENGINE_ASR_ACCESS_KEY') ||
    !compose.includes('VOLCENGINE_ASR_BASE_URL') ||
    !compose.includes('VOLCENGINE_ASR_RESOURCE_ID')
  ) {
    errors.push(
      'The API container must receive optional Volcengine dialect ASR settings.'
    );
  }
  if (
    !compose.includes('PHONE_VERIFICATION_REQUIRED') ||
    !compose.includes('PHONE_VERIFICATION_PROVIDER') ||
    !compose.includes('PHONE_VERIFICATION_HASH_SECRET') ||
    !compose.includes('PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_ID')
  ) {
    errors.push(
      'The API container must receive phone verification provider settings.'
    );
  }

  const deployScript = readProjectFile('deploy/scripts/deploy.sh');
  if (
    !deployScript.includes('run_deployment_check production') ||
    !deployScript.includes('health-check.sh')
  ) {
    errors.push(
      'The deployment script must validate configuration and run the HTTPS health check.'
    );
  }

  const privateDeployScript = readProjectFile(
    'deploy/scripts/deploy-private.sh'
  );
  if (
    !privateDeployScript.includes('run_deployment_check private') ||
    !privateDeployScript.includes('health-check-private.sh')
  ) {
    errors.push(
      'The private deployment script must validate the private profile and run its loopback health check.'
    );
  }

  const privateHealthScript = readProjectFile(
    'deploy/scripts/health-check-private.sh'
  );
  if (
    !privateHealthScript.includes('127.0.0.1') ||
    !privateHealthScript.includes('--resolve')
  ) {
    errors.push(
      'The private health check must verify the loopback-only HTTPS endpoint.'
    );
  }

  const bootstrapScript = readProjectFile(
    'deploy/scripts/bootstrap-lighthouse.sh'
  );
  if (
    !bootstrapScript.includes('download.docker.com/linux/ubuntu') ||
    !bootstrapScript.includes('dist-upgrade -y') ||
    !bootstrapScript.includes('docker-compose-plugin') ||
    !bootstrapScript.includes('mirror.ccs.tencentyun.com') ||
    !bootstrapScript.includes('log-driver') ||
    !bootstrapScript.includes('swapon /swapfile') ||
    !bootstrapScript.includes('PasswordAuthentication no') ||
    !bootstrapScript.includes('ufw allow OpenSSH')
  ) {
    errors.push(
      'The Lighthouse bootstrap must install Docker and configure bounded logs, swap, key-only SSH, and an SSH-only firewall.'
    );
  }

  const backupScript = readProjectFile('deploy/scripts/backup-mongo.sh');
  if (
    !backupScript.includes('mongodump') ||
    !backupScript.includes('umask 077') ||
    !backupScript.includes('BACKUP_RETENTION_DAYS') ||
    !backupScript.includes('resolve_docker_command') ||
    !backupScript.includes('DEPLOYMENT_PROJECT_NAME')
  ) {
    errors.push(
      'The MongoDB backup script must create private compressed backups with retention.'
    );
  }

  const restoreScript = readProjectFile('deploy/scripts/restore-mongo.sh');
  if (
    !restoreScript.includes('CONFIRM_RESTORE=RESTORE') ||
    !restoreScript.includes('mongorestore') ||
    !restoreScript.includes('--drop') ||
    !restoreScript.includes('resolve_docker_command') ||
    !restoreScript.includes('DEPLOYMENT_PROJECT_NAME')
  ) {
    errors.push(
      'The MongoDB restore script must require explicit confirmation before a complete restore.'
    );
  }

  const caddyfile = readProjectFile('deploy/Caddyfile');
  if (
    !caddyfile.includes('reverse_proxy api:10010') ||
    !caddyfile.includes('health_uri /health')
  ) {
    errors.push('Caddy must proxy to the API and use active health checks.');
  }

  return errors;
}

function runCli() {
  const exampleMode = process.argv.includes('--example');
  const privateMode = process.argv.includes('--private');
  const requestedEnvPath = process.argv
    .slice(2)
    .find(argument => !argument.startsWith('--'));
  const environmentPath = requestedEnvPath
    ? path.resolve(process.cwd(), requestedEnvPath)
    : undefined;
  const errors = validateProductionDeployment({
    environmentPath,
    exampleMode,
    privateMode
  });

  if (errors.length) {
    console.error('Production deployment validation failed:');
    errors.forEach(error => console.error(`- ${error}`));
    process.exitCode = 1;
    return;
  }

  console.log(
    `Production deployment ${
      exampleMode
        ? 'template'
        : privateMode
        ? 'private configuration'
        : 'configuration'
    } is valid.`
  );
}

if (require.main === module) {
  runCli();
}

module.exports = {
  parseEnv,
  validateDeploymentEmailConfiguration,
  validateProductionDeployment
};

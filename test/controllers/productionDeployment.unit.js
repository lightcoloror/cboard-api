'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const chai = require('chai');
const {
  validateProductionDeployment
} = require('../../scripts/checkProductionDeployment');

const expect = chai.expect;

function createEnvironment(overrides = {}) {
  const mongoPassword = 'mongo-password-1234567890abcdef';
  const values = {
    API_DOMAIN: 'api.picinterpreter.test',
    ACME_EMAIL: 'admin@picinterpreter.test',
    MONGO_USERNAME: 'cboard',
    MONGO_PASSWORD: mongoPassword,
    MONGO_URL:
      `mongodb://cboard:${mongoPassword}@mongo:27017/cboard-api` +
      '?authSource=admin',
    API_SESSION_SECRET: 'session-secret-1234567890-abcdef',
    JWT_SECRET: 'jwt-signing-secret-123456789-abcdef',
    AZURE_STORAGE_CONNECTION_STRING:
      'DefaultEndpointsProtocol=https;' +
      'AccountName=picinterpreter;' +
      'AccountKey=abc123abc123abc123abc123abc123abc123;' +
      'EndpointSuffix=core.windows.net',
    PRIVATE_LIBRARY_CONTAINER_NAME: 'cboard-private',
    PHONE_VERIFICATION_REQUIRED: 'true',
    PHONE_VERIFICATION_PROVIDER: 'tencentcloud',
    PHONE_VERIFICATION_HASH_SECRET:
      'phone-verification-secret-1234567890-abcdef',
    PHONE_VERIFICATION_TENCENTCLOUD_SECRET_ID: 'least-privilege-id',
    PHONE_VERIFICATION_TENCENTCLOUD_SECRET_KEY: 'least-privilege-key',
    PHONE_VERIFICATION_TENCENTCLOUD_SMS_SDK_APP_ID: '1400123456',
    PHONE_VERIFICATION_TENCENTCLOUD_SMS_SIGN_NAME: '图语家',
    PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_ID: '123456',
    PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_PARAMETERS: 'code,minutes',
    COMMUNICATION_ENHANCEMENT_RATE_LIMIT_ENABLED: 'true',
    COMMUNICATION_ENHANCEMENT_POINTS_PER_MINUTE: '30',
    COMMUNICATION_ENHANCEMENT_MONTHLY_POINTS: '1000',
    COMMUNICATION_AI_TOKEN_QUOTA_ENABLED: 'true',
    COMMUNICATION_AI_MONTHLY_TOKEN_QUOTA: '1000000',
    COMMUNICATION_AI_TEXT_TOKEN_RESERVATION: '4096',
    COMMUNICATION_AI_IMAGE_TOKEN_RESERVATION: '32768',
    ...overrides
  };

  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function runChecker(overrides) {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'cboard-production-config-')
  );
  const envPath = path.join(tempRoot, '.env.production');
  fs.writeFileSync(envPath, createEnvironment(overrides));
  try {
    return validateProductionDeployment({
      environmentPath: envPath
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe('Production deployment checker', function() {
  it('accepts an explicit private Azure library configuration', function() {
    const errors = runChecker();

    expect(errors).to.deep.equal([]);
  });

  it('accepts the minimal production profile without purchased optional services', function() {
    const errors = runChecker({
      AZURE_STORAGE_CONNECTION_STRING: '',
      PRIVATE_LIBRARY_CONTAINER_NAME: '',
      PHONE_VERIFICATION_REQUIRED: 'false',
      PHONE_VERIFICATION_PROVIDER: '',
      PHONE_VERIFICATION_HASH_SECRET: '',
      PHONE_VERIFICATION_TENCENTCLOUD_SECRET_ID: '',
      PHONE_VERIFICATION_TENCENTCLOUD_SECRET_KEY: '',
      PHONE_VERIFICATION_TENCENTCLOUD_SMS_SDK_APP_ID: '',
      PHONE_VERIFICATION_TENCENTCLOUD_SMS_SIGN_NAME: '',
      PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_ID: '',
      PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_PARAMETERS: ''
    });

    expect(errors).to.deep.equal([]);
  });

  it('rejects a partially configured Azure private library', function() {
    const errors = runChecker({ AZURE_STORAGE_CONNECTION_STRING: '' });

    expect(errors).to.include(
      'Azure private library requires both AZURE_STORAGE_CONNECTION_STRING and PRIVATE_LIBRARY_CONTAINER_NAME.'
    );
  });

  it('rejects an invalid private container name', function() {
    const errors = runChecker({
      PRIVATE_LIBRARY_CONTAINER_NAME: 'Private--Library'
    });

    expect(
      errors.some(error =>
        error.startsWith(
          'PRIVATE_LIBRARY_CONTAINER_NAME must be 3-63 lowercase letters'
        )
      )
    ).to.equal(true);
  });

  it('requires bounded enhancement limits in production', function() {
    const disabledErrors = runChecker({
      COMMUNICATION_ENHANCEMENT_RATE_LIMIT_ENABLED: 'false'
    });
    const invalidQuotaErrors = runChecker({
      COMMUNICATION_ENHANCEMENT_MONTHLY_POINTS: '0'
    });
    const disabledTokenErrors = runChecker({
      COMMUNICATION_AI_TOKEN_QUOTA_ENABLED: 'false'
    });
    const invalidTokenErrors = runChecker({
      COMMUNICATION_AI_MONTHLY_TOKEN_QUOTA: '1000',
      COMMUNICATION_AI_IMAGE_TOKEN_RESERVATION: '2000'
    });

    expect(disabledErrors).to.include(
      'COMMUNICATION_ENHANCEMENT_RATE_LIMIT_ENABLED must be true in production.'
    );
    expect(invalidQuotaErrors).to.include(
      'COMMUNICATION_ENHANCEMENT_MONTHLY_POINTS must be an integer between 1 and 10000000.'
    );
    expect(disabledTokenErrors).to.include(
      'COMMUNICATION_AI_TOKEN_QUOTA_ENABLED must be true in production.'
    );
    expect(invalidTokenErrors).to.include(
      'COMMUNICATION_AI_IMAGE_TOKEN_RESERVATION must not exceed COMMUNICATION_AI_MONTHLY_TOKEN_QUOTA.'
    );
  });

  it('requires complete provider settings only when phone verification is enabled', function() {
    const disabledErrors = runChecker({
      PHONE_VERIFICATION_REQUIRED: 'false',
      PHONE_VERIFICATION_PROVIDER: '',
      PHONE_VERIFICATION_HASH_SECRET: ''
    });
    const missingProviderErrors = runChecker({
      PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_ID: ''
    });
    const reusedSecretErrors = runChecker({
      PHONE_VERIFICATION_HASH_SECRET: 'session-secret-1234567890-abcdef'
    });

    expect(disabledErrors).to.deep.equal([]);
    expect(missingProviderErrors).to.include(
      'Missing required phone verification key: PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_ID'
    );
    expect(reusedSecretErrors).to.include(
      'PHONE_VERIFICATION_HASH_SECRET must be independent from session and JWT secrets.'
    );
  });

  it('rejects placeholder credentials when an optional service is enabled', function() {
    const errors = runChecker({
      PHONE_VERIFICATION_TENCENTCLOUD_SECRET_ID: 'replace-with-secret-id'
    });

    expect(errors).to.include(
      'PHONE_VERIFICATION_TENCENTCLOUD_SECRET_ID still contains a placeholder value.'
    );
  });

  it('validates the optional Volcengine flash ASR provider', function() {
    const completeErrors = runChecker({
      COMMUNICATION_DIALECT_ASR_PROVIDER: 'volcengine',
      VOLCENGINE_ASR_API_KEY: 'server-only-app-key',
      VOLCENGINE_ASR_BASE_URL:
        'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
      VOLCENGINE_ASR_RESOURCE_ID: 'volc.bigasr.auc_turbo'
    });
    const missingCredentialErrors = runChecker({
      COMMUNICATION_DIALECT_ASR_PROVIDER: 'volcengine',
      VOLCENGINE_ASR_API_KEY: '',
      VOLCENGINE_ASR_APP_KEY: 'legacy-app-only'
    });
    const insecureEndpointErrors = runChecker({
      COMMUNICATION_DIALECT_ASR_PROVIDER: 'volcengine',
      VOLCENGINE_ASR_API_KEY: 'server-only-app-key',
      VOLCENGINE_ASR_BASE_URL:
        'http://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash'
    });

    expect(completeErrors).to.deep.equal([]);
    expect(missingCredentialErrors).to.include(
      'Volcengine dialect ASR requires an API key or complete legacy App-Key and Access-Key credentials.'
    );
    expect(insecureEndpointErrors).to.include(
      'VOLCENGINE_ASR_BASE_URL must use HTTPS in production.'
    );
  });
});

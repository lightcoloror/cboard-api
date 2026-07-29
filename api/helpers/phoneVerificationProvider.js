'use strict';

const { sms } = require('tencentcloud-sdk-nodejs-sms');

const PROVIDER_NAME = 'tencentcloud';
const PROVIDER_ID = 'tencentcloud-sms';
const DEFAULT_TIMEOUT_SECONDS = 10;
const TEMPLATE_PARAMETER_NAMES = new Set(['code', 'minutes']);

function normalizeTimeoutSeconds(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout)) return DEFAULT_TIMEOUT_SECONDS;
  return Math.max(5, Math.min(30, Math.round(timeout)));
}

function normalizeTemplateParameters(value) {
  const parameters = String(value || 'code,minutes')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
  if (
    !parameters.length ||
    parameters.length > 2 ||
    parameters.some(item => !TEMPLATE_PARAMETER_NAMES.has(item))
  ) {
    return null;
  }
  return parameters;
}

function resolveTencentCloudSmsConfiguration(env = process.env) {
  const provider = String(env.PHONE_VERIFICATION_PROVIDER || '')
    .trim()
    .toLowerCase();
  if (provider !== PROVIDER_NAME) return null;

  const secretId = String(
    env.PHONE_VERIFICATION_TENCENTCLOUD_SECRET_ID ||
      env.TENCENTCLOUD_SECRET_ID ||
      ''
  ).trim();
  const secretKey = String(
    env.PHONE_VERIFICATION_TENCENTCLOUD_SECRET_KEY ||
      env.TENCENTCLOUD_SECRET_KEY ||
      ''
  ).trim();
  const smsSdkAppId = String(
    env.PHONE_VERIFICATION_TENCENTCLOUD_SMS_SDK_APP_ID || ''
  ).trim();
  const signName = String(
    env.PHONE_VERIFICATION_TENCENTCLOUD_SMS_SIGN_NAME || ''
  ).trim();
  const templateId = String(
    env.PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_ID || ''
  ).trim();
  const templateParameters = normalizeTemplateParameters(
    env.PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_PARAMETERS
  );
  if (
    !secretId ||
    !secretKey ||
    !smsSdkAppId ||
    !signName ||
    !templateId ||
    !templateParameters
  ) {
    return null;
  }

  return Object.freeze({
    provider,
    secretId,
    secretKey,
    smsSdkAppId,
    signName,
    templateId,
    templateParameters,
    region: String(env.PHONE_VERIFICATION_TENCENTCLOUD_SMS_REGION || '').trim(),
    timeoutSeconds: normalizeTimeoutSeconds(
      env.PHONE_VERIFICATION_TENCENTCLOUD_SMS_TIMEOUT_SECONDS
    )
  });
}

function createHttpError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function mapProviderError(error) {
  const providerCode = String((error && (error.code || error.Code)) || '');
  const providerMessage = String((error && error.message) || '');
  if (/LimitExceeded|RequestLimitExceeded/i.test(providerCode)) {
    return createHttpError(
      'Phone verification is temporarily rate limited.',
      429,
      'PHONE_VERIFICATION_PROVIDER_RATE_LIMITED'
    );
  }
  if (
    /Auth|Unauthorized|Secret|Signature|Template|SmsSdkAppId/i.test(
      providerCode
    )
  ) {
    return createHttpError(
      'Phone verification provider is not ready.',
      503,
      'PHONE_VERIFICATION_PROVIDER_NOT_READY'
    );
  }
  if (/timeout/i.test(`${providerCode} ${providerMessage}`)) {
    return createHttpError(
      'Phone verification provider timed out.',
      504,
      'PHONE_VERIFICATION_PROVIDER_TIMEOUT'
    );
  }
  return createHttpError(
    'Phone verification provider request failed.',
    502,
    'PHONE_VERIFICATION_PROVIDER_FAILED'
  );
}

function createTencentCloudSmsClient(configuration, sdk = sms.v20210111) {
  return new sdk.Client({
    credential: {
      secretId: configuration.secretId,
      secretKey: configuration.secretKey
    },
    region: configuration.region,
    profile: {
      signMethod: 'TC3-HMAC-SHA256',
      httpProfile: {
        endpoint: 'sms.tencentcloudapi.com',
        reqTimeout: configuration.timeoutSeconds
      }
    }
  });
}

function createPhoneVerificationProvider(options = {}) {
  const configuration =
    options.configuration || resolveTencentCloudSmsConfiguration(options.env);
  if (!configuration) return null;

  const client =
    options.client || createTencentCloudSmsClient(configuration, options.sdk);

  return {
    id: PROVIDER_ID,

    async sendCode({ phone, code, expiresInMinutes, challengeId }) {
      const parameterValues = configuration.templateParameters.map(name =>
        name === 'code' ? code : String(expiresInMinutes)
      );
      let response;
      try {
        response = await client.SendSms({
          PhoneNumberSet: [`+86${phone}`],
          SmsSdkAppId: configuration.smsSdkAppId,
          SignName: configuration.signName,
          TemplateId: configuration.templateId,
          TemplateParamSet: parameterValues,
          SessionContext: challengeId
        });
      } catch (error) {
        throw mapProviderError(error);
      }

      const status =
        response &&
        Array.isArray(response.SendStatusSet) &&
        response.SendStatusSet[0];
      if (!status || status.Code !== 'Ok') {
        throw mapProviderError({
          code: (status && status.Code) || 'UnknownProviderResponse'
        });
      }
      return {
        requestId: String((response && response.RequestId) || '').slice(0, 128)
      };
    }
  };
}

module.exports = {
  DEFAULT_TIMEOUT_SECONDS,
  PROVIDER_ID,
  PROVIDER_NAME,
  createPhoneVerificationProvider,
  createTencentCloudSmsClient,
  mapProviderError,
  normalizeTemplateParameters,
  resolveTencentCloudSmsConfiguration
};

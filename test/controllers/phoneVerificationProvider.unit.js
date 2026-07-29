'use strict';

const chai = require('chai');
const {
  createPhoneVerificationProvider,
  createTencentCloudSmsClient,
  normalizeTemplateParameters,
  resolveTencentCloudSmsConfiguration
} = require('../../api/helpers/phoneVerificationProvider');

const expect = chai.expect;

function createConfiguration(overrides = {}) {
  return {
    provider: 'tencentcloud',
    secretId: 'server-secret-id',
    secretKey: 'server-secret-key',
    smsSdkAppId: '1400123456',
    signName: '图语家',
    templateId: '123456',
    templateParameters: ['code', 'minutes'],
    region: '',
    timeoutSeconds: 10,
    ...overrides
  };
}

describe('Phone verification provider', function() {
  it('stays unavailable until every server-side Tencent setting exists', function() {
    expect(resolveTencentCloudSmsConfiguration({})).to.equal(null);
    expect(
      resolveTencentCloudSmsConfiguration({
        PHONE_VERIFICATION_PROVIDER: 'tencentcloud',
        PHONE_VERIFICATION_TENCENTCLOUD_SECRET_ID: 'id-only'
      })
    ).to.equal(null);
    expect(
      resolveTencentCloudSmsConfiguration({
        PHONE_VERIFICATION_PROVIDER: 'tencentcloud',
        PHONE_VERIFICATION_TENCENTCLOUD_SECRET_ID: 'id',
        PHONE_VERIFICATION_TENCENTCLOUD_SECRET_KEY: 'key',
        PHONE_VERIFICATION_TENCENTCLOUD_SMS_SDK_APP_ID: '1400123456',
        PHONE_VERIFICATION_TENCENTCLOUD_SMS_SIGN_NAME: '图语家',
        PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_ID: '123456'
      })
    ).to.include({
      provider: 'tencentcloud',
      smsSdkAppId: '1400123456',
      templateId: '123456',
      timeoutSeconds: 10
    });
  });

  it('accepts only the reviewed code and minutes template variables', function() {
    expect(normalizeTemplateParameters('code')).to.deep.equal(['code']);
    expect(normalizeTemplateParameters('code,minutes')).to.deep.equal([
      'code',
      'minutes'
    ]);
    expect(normalizeTemplateParameters('phone,code')).to.equal(null);
    expect(normalizeTemplateParameters('')).to.deep.equal(['code', 'minutes']);
  });

  it('keeps credentials only in the official SDK client', function() {
    let clientConfiguration;
    createTencentCloudSmsClient(createConfiguration(), {
      Client: function Client(configuration) {
        clientConfiguration = configuration;
      }
    });

    expect(clientConfiguration.credential).to.deep.equal({
      secretId: 'server-secret-id',
      secretKey: 'server-secret-key'
    });
    expect(clientConfiguration.profile.httpProfile).to.deep.equal({
      endpoint: 'sms.tencentcloudapi.com',
      reqTimeout: 10
    });
  });

  it('sends one E.164 phone through the approved template', async function() {
    let request;
    const provider = createPhoneVerificationProvider({
      configuration: createConfiguration(),
      client: {
        async SendSms(value) {
          request = value;
          return {
            RequestId: 'request-id',
            SendStatusSet: [{ Code: 'Ok' }]
          };
        }
      }
    });

    const result = await provider.sendCode({
      phone: '13800138000',
      code: '123456',
      expiresInMinutes: 5,
      challengeId: 'a'.repeat(64)
    });

    expect(request).to.deep.equal({
      PhoneNumberSet: ['+8613800138000'],
      SmsSdkAppId: '1400123456',
      SignName: '图语家',
      TemplateId: '123456',
      TemplateParamSet: ['123456', '5'],
      SessionContext: 'a'.repeat(64)
    });
    expect(result).to.deep.equal({ requestId: 'request-id' });
    expect(result).not.to.have.property('phone');
  });

  it('maps provider failures without returning upstream details', async function() {
    const provider = createPhoneVerificationProvider({
      configuration: createConfiguration(),
      client: {
        async SendSms() {
          const error = new Error('secret provider diagnostic');
          error.code = 'AuthFailure.SecretIdNotFound';
          throw error;
        }
      }
    });

    let caught;
    try {
      await provider.sendCode({
        phone: '13800138000',
        code: '123456',
        expiresInMinutes: 5,
        challengeId: 'a'.repeat(64)
      });
    } catch (error) {
      caught = error;
    }

    expect(caught.status).to.equal(503);
    expect(caught.code).to.equal('PHONE_VERIFICATION_PROVIDER_NOT_READY');
    expect(caught.message).not.to.contain('secret provider diagnostic');
  });
});

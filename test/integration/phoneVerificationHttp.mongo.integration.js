'use strict';

const mongoUrl = process.env.PHONE_VERIFICATION_HTTP_MONGO_TEST_URL;
const providerOrigin = 'https://sms.tencentcloudapi.com';

if (mongoUrl) {
  process.env.NODE_ENV = 'test';
  process.env.MONGO_URL = mongoUrl;
  process.env.PORT = process.env.PHONE_VERIFICATION_HTTP_TEST_PORT || '19125';
  process.env.API_SESSION_SECRET = 'phone-verification-integration-session';
  process.env.JWT_SECRET = 'phone-verification-integration-jwt';
  process.env.PHONE_VERIFICATION_PROVIDER = 'tencentcloud';
  process.env.PHONE_VERIFICATION_HASH_SECRET =
    'phone-verification-integration-hash-secret-20260729';
  process.env.PHONE_VERIFICATION_REQUIRED = 'true';
  process.env.PHONE_VERIFICATION_TENCENTCLOUD_SECRET_ID = 'AKIDEXAMPLE';
  process.env.PHONE_VERIFICATION_TENCENTCLOUD_SECRET_KEY = 'secret-example';
  process.env.PHONE_VERIFICATION_TENCENTCLOUD_SMS_SDK_APP_ID = '1400000000';
  process.env.PHONE_VERIFICATION_TENCENTCLOUD_SMS_SIGN_NAME = 'PicInterpreter';
  process.env.PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_ID = '123456';
  process.env.PHONE_VERIFICATION_TENCENTCLOUD_SMS_TEMPLATE_PARAMETERS =
    'code,minutes';
  const noProxy = [
    String(process.env.NO_PROXY || process.env.no_proxy || '').trim(),
    'sms.tencentcloudapi.com'
  ]
    .filter(Boolean)
    .join(',');
  process.env.NO_PROXY = noProxy;
  process.env.no_proxy = noProxy;
}

const chai = require('chai');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const nock = require('nock');
const request = require('supertest');
const helper = require('../helper');

const expect = chai.expect;
const describeWithMongo = mongoUrl ? describe : describe.skip;
const rateLimitCollectionNames = [
  'phoneVerificationIpHourlyLimits',
  'phoneVerificationPhoneDailyLimits',
  'phoneVerificationResendLimits'
];

async function waitForMongoConnection() {
  if (mongoose.connection.readyState === 1) return;
  await new Promise((resolve, reject) => {
    mongoose.connection.once('connected', resolve);
    mongoose.connection.once('error', reject);
  });
}

async function clearRateLimitState() {
  await Promise.all(
    rateLimitCollectionNames.map(name =>
      mongoose.connection.db.collection(name).deleteMany({})
    )
  );
}

describeWithMongo('Phone verification HTTP with Mongo', function() {
  this.timeout(30000);

  const phone = '13800138000';
  let app;
  let capturedProviderBody;
  let firstEmail;
  let secondEmail;
  let authenticationEmail;
  let authenticationUserId;
  let PhoneVerificationChallenge;
  let Settings;
  let TempUser;
  let User;

  before(async function() {
    helper.prepareNodemailerMock();
    app = require('../../app');
    PhoneVerificationChallenge = require('../../api/models/PhoneVerificationChallenge');
    Settings = require('../../api/models/Settings');
    TempUser = require('../../api/mail').nev.options.tempUserModel;
    User = require('../../api/models/User');
    await waitForMongoConnection();
    await clearRateLimitState();
  });

  after(async function() {
    nock.cleanAll();
    helper.prepareNodemailerMock(true);
    if (TempUser) {
      await TempUser.deleteMany({ email: { $in: [firstEmail, secondEmail] } });
    }
    if (Settings && authenticationUserId) {
      await Settings.deleteMany({ user: authenticationUserId });
    }
    if (User && authenticationEmail) {
      await User.deleteMany({ email: authenticationEmail });
    }
    if (PhoneVerificationChallenge) {
      await PhoneVerificationChallenge.deleteMany({
        phoneMasked: { $in: ['138****8000', '139****9000'] }
      });
    }
    if (mongoose.connection.readyState === 1) {
      await clearRateLimitState();
    }
  });

  it('signs one provider request and consumes the confirmed token once', async function() {
    const configuration = await request(app)
      .get('/user/phone-verification')
      .expect('Content-Type', /json/)
      .expect(200);

    expect(configuration.body).to.include({
      available: true,
      requiredForPhoneRegistration: true,
      codeLength: 6
    });
    expect(configuration.body).not.to.have.any.keys(
      'secretId',
      'secretKey',
      'hashSecret'
    );

    nock(providerOrigin)
      .post('/')
      .matchHeader('x-tc-action', 'SendSms')
      .matchHeader('x-tc-version', '2021-01-11')
      .matchHeader('authorization', /^TC3-HMAC-SHA256 Credential=AKIDEXAMPLE\//)
      .reply(function(_uri, body) {
        capturedProviderBody = body;
        return [
          200,
          {
            Response: {
              SendStatusSet: [
                {
                  Code: 'Ok',
                  Message: 'send success',
                  PhoneNumber: `+86${phone}`,
                  SessionContext: body.SessionContext,
                  Fee: 1,
                  SerialNo: 'integration-serial'
                }
              ],
              RequestId: 'integration-request-id'
            }
          }
        ];
      });

    const challenge = await request(app)
      .post('/user/phone-verification')
      .send({ phone, purpose: 'registration' })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(challenge.body).to.include({
      phoneMasked: '138****8000',
      expiresInSeconds: 300,
      resendAfterSeconds: 60
    });
    expect(challenge.body.challengeId).to.match(/^[a-f0-9]{64}$/);
    expect(challenge.body).not.to.have.any.keys('code', 'verificationToken');
    expect(capturedProviderBody).to.deep.include({
      PhoneNumberSet: [`+86${phone}`],
      SmsSdkAppId: '1400000000',
      SignName: 'PicInterpreter',
      TemplateId: '123456',
      SessionContext: challenge.body.challengeId
    });
    expect(capturedProviderBody.TemplateParamSet).to.have.length(2);
    expect(capturedProviderBody.TemplateParamSet[0]).to.match(/^\d{6}$/);
    expect(capturedProviderBody.TemplateParamSet[1]).to.equal('5');
    expect(JSON.stringify(challenge.body)).not.to.include(
      capturedProviderBody.TemplateParamSet[0]
    );
    expect(nock.isDone()).to.equal(true);

    const invalidConfirmation = await request(app)
      .post('/user/phone-verification/confirm')
      .send({
        challengeId: challenge.body.challengeId,
        phone,
        code: '000000',
        purpose: 'registration'
      })
      .expect('Content-Type', /json/)
      .expect(400);

    expect(invalidConfirmation.body).to.deep.include({
      error: { code: 'PHONE_VERIFICATION_INVALID_CODE' }
    });

    const confirmation = await request(app)
      .post('/user/phone-verification/confirm')
      .send({
        challengeId: challenge.body.challengeId,
        phone,
        code: capturedProviderBody.TemplateParamSet[0],
        purpose: 'registration'
      })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(confirmation.body.verificationToken).to.match(/^[a-f0-9]{64}$/);
    expect(confirmation.body.expiresInSeconds).to.equal(600);

    firstEmail = helper.generateEmail();
    const registration = await request(app)
      .post('/user')
      .set('X-Forwarded-For', '127.0.0.1')
      .send({
        name: 'cboard mocha test',
        email: firstEmail,
        password: '123456',
        phone,
        phoneVerificationToken: confirmation.body.verificationToken
      })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(registration.body).to.include({ success: 1 });
    expect(registration.body).not.to.have.any.keys(
      'phone',
      'phoneVerificationToken',
      'verificationToken'
    );
    const temporaryUser = await TempUser.findOne({ email: firstEmail }).lean();
    expect(temporaryUser).to.include({ phone });

    const storedChallenge = await PhoneVerificationChallenge.findOne({
      challengeId: challenge.body.challengeId
    }).lean();
    expect(storedChallenge).to.include({
      provider: 'tencentcloud-sms',
      providerRequestId: 'integration-request-id',
      phoneMasked: '138****8000',
      purpose: 'registration',
      attempts: 1
    });
    expect(storedChallenge.consumedAt).to.be.instanceOf(Date);
    expect(JSON.stringify(storedChallenge)).not.to.include(phone);
    expect(JSON.stringify(storedChallenge)).not.to.include(
      capturedProviderBody.TemplateParamSet[0]
    );

    await TempUser.deleteOne({ email: firstEmail });
    secondEmail = helper.generateEmail();
    const replay = await request(app)
      .post('/user')
      .set('X-Forwarded-For', '127.0.0.1')
      .send({
        name: 'cboard mocha test',
        email: secondEmail,
        password: '123456',
        phone,
        phoneVerificationToken: confirmation.body.verificationToken
      })
      .expect('Content-Type', /json/)
      .expect(403);

    expect(replay.body).to.deep.include({
      error: { code: 'PHONE_VERIFICATION_REQUIRED' }
    });
    expect(await TempUser.countDocuments({ email: secondEmail })).to.equal(0);
  });

  it('uses purpose-bound provider challenges for phone login and password reset', async function() {
    const authenticationPhone = '13900139000';
    const oldPassword = 'old-password-123';
    const newPassword = 'new-password-456';

    async function requestConfirmedToken(purpose, providerRequestId) {
      let providerBody;
      nock(providerOrigin)
        .post('/')
        .matchHeader('x-tc-action', 'SendSms')
        .matchHeader('x-tc-version', '2021-01-11')
        .matchHeader(
          'authorization',
          /^TC3-HMAC-SHA256 Credential=AKIDEXAMPLE\//
        )
        .reply(function(_uri, body) {
          providerBody = body;
          return [
            200,
            {
              Response: {
                SendStatusSet: [
                  {
                    Code: 'Ok',
                    Message: 'send success',
                    PhoneNumber: `+86${authenticationPhone}`,
                    SessionContext: body.SessionContext,
                    Fee: 1,
                    SerialNo: `${providerRequestId}-serial`
                  }
                ],
                RequestId: providerRequestId
              }
            }
          ];
        });

      const challenge = await request(app)
        .post('/user/phone-verification')
        .send({ phone: authenticationPhone, purpose })
        .expect('Content-Type', /json/)
        .expect(200);
      expect(providerBody).to.deep.include({
        PhoneNumberSet: [`+86${authenticationPhone}`],
        SessionContext: challenge.body.challengeId
      });

      const confirmation = await request(app)
        .post('/user/phone-verification/confirm')
        .send({
          challengeId: challenge.body.challengeId,
          phone: authenticationPhone,
          code: providerBody.TemplateParamSet[0],
          purpose
        })
        .expect('Content-Type', /json/)
        .expect(200);

      expect(confirmation.body.verificationToken).to.match(/^[a-f0-9]{64}$/);
      return {
        challengeId: challenge.body.challengeId,
        verificationToken: confirmation.body.verificationToken
      };
    }

    await clearRateLimitState();
    authenticationEmail = helper.generateEmail();
    const user = await User.create({
      name: 'phone authentication integration',
      email: authenticationEmail,
      phone: authenticationPhone,
      password: await bcrypt.hash(oldPassword, 10)
    });
    authenticationUserId = user._id;

    const loginVerification = await requestConfirmedToken(
      'login',
      'login-integration-request-id'
    );

    await request(app)
      .post('/user/store-password/phone')
      .send({
        phone: authenticationPhone,
        phoneVerificationToken: loginVerification.verificationToken,
        password: newPassword
      })
      .expect('Content-Type', /json/)
      .expect(400);

    const phoneLogin = await request(app)
      .post('/user/login/phone')
      .set('X-Forwarded-For', '127.0.0.1')
      .send({
        phone: authenticationPhone,
        phoneVerificationToken: loginVerification.verificationToken
      })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(phoneLogin.body).to.include({
      email: authenticationEmail,
      phoneMasked: '139****9000'
    });
    expect(phoneLogin.body.authToken).to.be.a('string').and.not.empty;
    expect(phoneLogin.body).not.to.have.property('phone');

    await request(app)
      .post('/user/login/phone')
      .set('X-Forwarded-For', '127.0.0.1')
      .send({
        phone: authenticationPhone,
        phoneVerificationToken: loginVerification.verificationToken
      })
      .expect('Content-Type', /json/)
      .expect(401);

    await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${phoneLogin.body.authToken}`)
      .expect('Content-Type', /json/)
      .expect(200);

    await clearRateLimitState();
    const resetVerification = await requestConfirmedToken(
      'password-reset',
      'password-reset-integration-request-id'
    );

    await request(app)
      .post('/user/store-password/phone')
      .send({
        phone: authenticationPhone,
        phoneVerificationToken: resetVerification.verificationToken,
        password: newPassword
      })
      .expect('Content-Type', /json/)
      .expect(200);

    await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${phoneLogin.body.authToken}`)
      .expect('Content-Type', /json/)
      .expect(403);

    await request(app)
      .post('/user/store-password/phone')
      .send({
        phone: authenticationPhone,
        phoneVerificationToken: resetVerification.verificationToken,
        password: newPassword
      })
      .expect('Content-Type', /json/)
      .expect(400);

    await request(app)
      .post('/user/login')
      .set('X-Forwarded-For', '127.0.0.1')
      .send({ email: authenticationEmail, password: oldPassword })
      .expect(401);

    const passwordLogin = await request(app)
      .post('/user/login')
      .set('X-Forwarded-For', '127.0.0.1')
      .send({ email: authenticationEmail, password: newPassword })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(passwordLogin.body.authToken).to.be.a('string').and.not.empty;
    const currentSession = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${passwordLogin.body.authToken}`)
      .expect('Content-Type', /json/)
      .expect(200);
    expect(currentSession.body).not.to.have.property('authVersion');

    const storedUser = await User.findById(authenticationUserId).lean();
    expect(storedUser.authVersion).to.equal(1);
    expect(await bcrypt.compare(oldPassword, storedUser.password)).to.equal(
      false
    );
    expect(await bcrypt.compare(newPassword, storedUser.password)).to.equal(
      true
    );

    const storedChallenges = await PhoneVerificationChallenge.find({
      challengeId: {
        $in: [loginVerification.challengeId, resetVerification.challengeId]
      }
    }).lean();
    expect(storedChallenges).to.have.length(2);
    expect(storedChallenges.map(item => item.purpose).sort()).to.deep.equal([
      'login',
      'password-reset'
    ]);
    storedChallenges.forEach(item => {
      expect(item.consumedAt).to.be.instanceOf(Date);
      expect(JSON.stringify(item)).not.to.include(authenticationPhone);
    });
    expect(nock.isDone()).to.equal(true);
  });
});

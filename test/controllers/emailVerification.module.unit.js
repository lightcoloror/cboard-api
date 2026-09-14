'use strict';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('email-verification module resend and transport guards', function() {
  let nev;
  let transport;
  let verifyCalls;
  let sentMail;
  let temporaryUser;
  let temporaryLookupError;
  let savedTemporaryUsers;

  beforeEach(function() {
    verifyCalls = 0;
    sentMail = [];
    temporaryUser = null;
    temporaryLookupError = null;
    savedTemporaryUsers = [];
    transport = {
      verify(callback) {
        verifyCalls += 1;
        callback(null, true);
      },
      sendMail(message, callback) {
        sentMail.push(message);
        callback(null, { response: 'synthetic accepted' });
      }
    };

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('nodemailer', {
      createTransport() {
        return transport;
      }
    });
    nev = require('../../api/mail/email-verification')({
      Schema() { return { methods: {} }; },
      model() { return null; }
    });
    nev.options.tempUserModel = {
      findOne(query, callback) {
        callback(temporaryLookupError, temporaryUser);
      }
    };
  });

  afterEach(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  function configure(transportOptions) {
    return new Promise((resolve, reject) => {
      nev.configure(
        {
          transportOptions,
          verificationURL: '${DOMAIN}/activate/${URL}',
          verifyMailOptions: {
            from: 'No Reply <noreply@example.test>',
            subject: 'Verify',
            html: '${URL}',
            text: '${URL}'
          }
        },
        error => (error ? reject(error) : resolve())
      );
    });
  }

  function resend(email) {
    return new Promise(resolve => {
      nev.resendVerificationEmail(email, 'https://app.example.test', (error, sent) =>
        resolve({ error, sent })
      );
    });
  }

  function confirm(url) {
    return new Promise(resolve => {
      nev.confirmTempUser(url, (error, user) => resolve({ error, user }));
    });
  }

  it('does not verify or connect when transport credentials are absent', async function() {
    await configure({ host: 'smtp.example.test', auth: { user: '', pass: '' } });
    expect(verifyCalls).to.equal(0);
  });

  it('verifies a complete configured transport through the injected local transport only', async function() {
    await configure({
      host: 'smtp.example.test',
      auth: { user: 'apikey', pass: 'synthetic-secret' }
    });
    expect(verifyCalls).to.equal(1);
  });

  it('rotates a pending URL, preserves createdAt, and sends through the mock transport', async function() {
    await configure({
      host: 'smtp.example.test',
      auth: { user: 'apikey', pass: 'synthetic-secret' }
    });
    const createdAt = new Date(Date.now() - 1000);
    temporaryUser = {
      email: 'care@example.test',
      createdAt,
      GENERATED_VERIFYING_URL: 'old-url',
      save(callback) {
        savedTemporaryUsers.push({
          url: this.GENERATED_VERIFYING_URL,
          createdAt: this.createdAt
        });
        callback(null);
      }
    };

    const result = await resend('care@example.test');
    expect(result.error).to.equal(null);
    expect(result.sent).to.equal(true);
    expect(savedTemporaryUsers).to.have.length(1);
    expect(savedTemporaryUsers[0].url).not.to.equal('old-url');
    expect(savedTemporaryUsers[0].createdAt).to.equal(createdAt);
    expect(sentMail).to.have.length(1);
    expect(sentMail[0].to).to.equal('care@example.test');
  });

  it('does not resend or activate an expired temporary record before Mongo TTL cleanup', async function() {
    await configure({
      host: 'smtp.example.test',
      auth: { user: 'apikey', pass: 'synthetic-secret' }
    });
    temporaryUser = {
      email: 'care@example.test',
      createdAt: new Date(Date.now() - nev.options.expirationTime * 1000 - 1),
      GENERATED_VERIFYING_URL: 'expired-url',
      save(callback) {
        savedTemporaryUsers.push(this);
        callback(null);
      }
    };

    const resendResult = await resend('care@example.test');
    expect(resendResult.error).to.equal(null);
    expect(resendResult.sent).to.equal(false);
    expect(savedTemporaryUsers).to.deep.equal([]);
    expect(sentMail).to.deep.equal([]);

    const activationResult = await confirm('expired-url');
    expect(activationResult.error).to.equal(null);
    expect(activationResult.user).to.equal(null);
  });

  it('does not touch a missing or already-consumed temporary account', async function() {
    await configure({
      host: 'smtp.example.test',
      auth: { user: 'apikey', pass: 'synthetic-secret' }
    });
    temporaryUser = null;
    const result = await resend('confirmed@example.test');
    expect(result.error).to.equal(null);
    expect(result.sent).to.equal(false);
    expect(savedTemporaryUsers).to.deep.equal([]);
    expect(sentMail).to.deep.equal([]);
  });
});

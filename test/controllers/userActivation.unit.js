'use strict';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('user activation', function() {
  let controller;
  let confirmationMode;
  let confirmationCalls;

  beforeEach(function() {
    confirmationMode = 'success';
    confirmationCalls = [];

    const nev = {
      options: {},
      confirmTempUser(url, callback) {
        callback(null, { _id: 'confirmed-user', email: 'confirmed@example.test' });
      },
      sendConfirmationEmail(email, callback) {
        confirmationCalls.push(email);
        if (confirmationMode === 'pending') return;
        if (confirmationMode === 'throw') throw new Error('provider failure');
        if (confirmationMode === 'callback-error') {
          callback(new Error('provider failure'), { response: 'provider detail' });
          return;
        }
        callback(null, { accepted: [email] });
      }
    };

    mockery.enable({ warnOnReplace: false, warnOnUnregistered: false, useCleanCache: true });
    mockery.registerMock('../models/User', {});
    mockery.registerMock('../models/ResetPassword', {});
    mockery.registerMock('../models/Settings', {});
    mockery.registerMock('../models/Subscribers', {});
    mockery.registerMock('../mail', { nev });
    mockery.registerMock('../helpers/auth', {});
    mockery.registerMock('../helpers/localize', { isLocalIp() { return false; } });
    mockery.registerMock('../helpers/userPhone', {});
    mockery.registerMock('../helpers/registrationInput', function() {});
    mockery.registerMock('../helpers/phoneVerificationRuntime', { phoneVerificationService: {} });
    mockery.registerMock('./account', { removeAccount() {} });
    mockery.registerMock('../helpers/emailVerificationResendRateLimit', {
      async consumeEmailVerificationResendLimits() {},
      emailVerificationResendRateLimit: null
    });
    mockery.registerMock('../helpers/authRequestRateLimit', {
      async consumeAuthRequestLimits() {},
      getAuthRequestLimiters() { return {}; }
    });
    mockery.registerMock('../helpers/passwordReset', {});
    mockery.registerMock('../helpers/userAccess', {});
    mockery.registerMock('../helpers/emailLinkOrigin', { configuredEmailAppOrigin() { return null; } });
    mockery.registerMock('../helpers/careFamilyLifecycle', { createCareFamilyLifecycle() { return {}; } });
    mockery.registerMock('../../config', { emailTransport: {} });
    controller = require('../../api/controllers/user');
  });

  afterEach(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  function response() {
    return {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
  }

  function request() {
    return { swagger: { params: { url: { value: 'verification-url' } } } };
  }

  ['success', 'callback-error', 'throw', 'pending'].forEach(function(mode) {
    it(`keeps persisted activation successful when welcome notification ${mode}`, function() {
      confirmationMode = mode;
      const res = response();

      controller.activateUser(request(), res);

      expect(confirmationCalls).to.deep.equal(['confirmed@example.test']);
      expect(res.statusCode).to.equal(200);
      expect(res.body).to.deep.equal({
        success: 1,
        userid: 'confirmed-user',
        message: 'CONFIRMED!'
      });
      expect(JSON.stringify(res.body)).not.to.contain('provider');
    });
  });
});

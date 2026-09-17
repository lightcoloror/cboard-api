'use strict';

// Synthetic controller/service acceptance fixture. The enclosing runner owns the
// explicitly isolated Mongo connection and its final database cleanup.
const assert = require('assert').strict;
const crypto = require('crypto');
const mockery = require('mockery');
const nodemailer = require('nodemailer');

module.exports = async function selfServiceOnboardingFixture({ mongoose, passed }) {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'self-service-onboarding-fixture-jwt';
  process.env.API_SESSION_SECRET = process.env.API_SESSION_SECRET || 'self-service-onboarding-fixture-session';
  process.env.CARE_ENCRYPTION_ACTIVE_KEY = process.env.CARE_ENCRYPTION_ACTIVE_KEY || 'onboarding';
  process.env.CARE_ENCRYPTION_KEYS = process.env.CARE_ENCRYPTION_KEYS || JSON.stringify({
    onboarding: crypto.randomBytes(32).toString('hex')
  });

  const config = require('../../config');
  const outbox = [];
  const originalTransport = config.emailTransport;
  const originalOrigin = config.AUTH_EMAIL_APP_URL;
  const controllerPath = require.resolve('../../api/controllers/user');
  const mailPath = require.resolve('../../api/mail');
  const verificationPath = require.resolve('../../api/mail/email-verification');
  const cached = new Map([
    [controllerPath, require.cache[controllerPath]],
    [mailPath, require.cache[mailPath]],
    [verificationPath, require.cache[verificationPath]]
  ]);

  const request = body => ({
    body,
    ip: '127.0.0.1',
    session: {},
    get(name) { return name === 'User-Agent' ? 'self-service-onboarding-fixture' : ''; },
    swagger: { params: {} }
  });

  config.emailTransport = {
    from: 'Self-service fixture <noreply@example.test>',
    host: 'smtp.example.test',
    port: 587,
    auth: { user: 'fixture-user', pass: 'fixture-pass' }
  };
  config.AUTH_EMAIL_APP_URL = 'https://app.example.test';
  delete require.cache[controllerPath];
  delete require.cache[mailPath];
  delete require.cache[verificationPath];
  mockery.enable({ warnOnReplace: false, warnOnUnregistered: false, useCleanCache: false });
  mockery.registerMock('nodemailer', {
    createTransport() {
      const transport = nodemailer.createTransport({ jsonTransport: true });
      transport.verify = callback => callback(null, true);
      const send = transport.sendMail.bind(transport);
      transport.sendMail = (message, callback) => send(message, (error, info) => {
        if (!error) outbox.push(JSON.parse(info.message));
        callback(error, info);
      });
      return transport;
    }
  });

  let server;
  try {
    // `api/mail` loads the real email-verification implementation; nodemailer is
    // the only substituted boundary and never creates a network transport.
    const { nev } = require('../../api/mail');
    const controller = require('../../api/controllers/user');
    const User = require('../../api/models/User');
    const auth = require('../../api/helpers/auth');
    const sessions = require('../../api/helpers/deviceSessions');
    // Reuse the existing care HTTP fixture's real Swagger metadata/router stack.
    // Only mail delivery is substituted; requests cross a loopback HTTP socket.
    const express = require('express');
    const spec = require('yamljs').load(require('path').resolve(__dirname, '../../api/swagger/swagger.yaml'));
    const api = express();
    api.use(express.json());
    api.use(require('express-session')({ secret: 'synthetic-onboarding-session', resave: false, saveUninitialized: false }));
    await new Promise((resolve, reject) => require('swagger-tools').initializeMiddleware(spec, middleware => {
      try {
        api.use(middleware.swaggerMetadata());
        api.use(middleware.swaggerRouter({ controllers: Object.fromEntries(
          Object.entries(controller).map(([name, handler]) => [`user_${name}`, handler])
        ), ignoreMissingHandlers: true }));
        api.use((error, req, res, next) => res.status(error.statusCode || error.status || 500).json({ code: 'TEST_HTTP_ERROR' }));
        resolve();
      } catch (error) { reject(error); }
    }));
    server = api.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const run = async (handler, input) => {
      const operation = Object.keys(controller).find(key => controller[key] === handler);
      let route;
      let method;
      for (const [path, operations] of Object.entries(spec.paths)) {
        for (const [verb, value] of Object.entries(operations)) {
          if (value.operationId === operation) { route = path; method = verb.toUpperCase(); }
        }
      }
      assert(route, 'controller operation must have a real Swagger route');
      route = route.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(input.swagger.params[key].value));
      const result = await fetch(base + route, { method,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'self-service-onboarding-fixture' },
        ...(input.body && method !== 'GET' ? { body: JSON.stringify(input.body) } : {})
      });
      return { code: result.status, body: await result.json(), headers: { 'Retry-After': result.headers.get('retry-after') } };
    };

    const suffix = new mongoose.Types.ObjectId().toString();
    const password = 'synthetic-onboarding-password';
    const registerAndLogin = async (label, role) => {
      const email = `onboarding-${label}-${suffix}@example.test`;
      const registration = await run(controller.createUser, request({
        name: `Synthetic ${label}`,
        email,
        password
      }));
      assert.equal(registration.code, 200);
      assert.equal(registration.body.success, 1);

      const temporary = await nev.options.tempUserModel.findOne({ email }).lean().exec();
      assert(temporary, 'registration must create a temporary user');
      assert.equal(await User.countDocuments({ email }), 0);
      const verification = outbox.find(message => JSON.stringify(message.to).includes(email) && message.text.includes('/activate/'));
      assert(verification, 'registration must generate a verification email');
      const link = verification.text.match(/https:\/\/app\.example\.test\/activate\/([A-Za-z0-9_-]+)/);
      assert(link, 'generated email must contain the configured activation link');
      assert.equal(link[1], temporary[nev.options.URLFieldName]);

      const beforeActivationLogin = await run(controller.loginUser, request({ email, password }));
      assert.equal(beforeActivationLogin.code, 401);

      const activation = await run(controller.activateUser, {
        swagger: { params: { url: { value: link[1] } } }
      });
      assert.equal(activation.code, 200);
      assert.equal(activation.body.success, 1);
      assert.equal(await nev.options.tempUserModel.countDocuments({ email }), 0);
      const user = await User.findOne({ email }).lean().exec();
      assert(user, 'activation must persist the confirmed user');
      assert.equal(String(activation.body.userid), String(user._id));

      const wrongPasswordLogin = await run(controller.loginUser, request({
        email,
        password: 'synthetic-wrong-password'
      }));
      assert.equal(wrongPasswordLogin.code, 401);

      const login = await run(controller.loginUser, request({ email, password }));
      assert.equal(login.code, 200);
      assert(login.body.settings, 'login must create and return settings');
      assert.equal(typeof login.body.authToken, 'string');
      const bearer = auth.getTokenData(login.body.authToken);
      assert(bearer, 'login token must be signed by the real auth helper');
      assert.equal(String(bearer.id), String(user._id));
      assert.equal(await sessions.valid(bearer), true);
      return { id: String(user._id), role, email, bearer: login.body.authToken };
    };

    const owner = await registerAndLogin('owner', 'patient');
    const invitee = await registerAndLogin('invitee', 'relative');
    const care = require('../../api/helpers/careRuntime').createRuntime();
    const family = await care.createFamily(owner.id, { name: 'Synthetic onboarding family' });
    const profile = await care.createProfile(owner.id, {
      familyId: family.id,
      name: 'Synthetic patient profile',
      role: owner.role
    });
    assert.equal((await care.profiles(owner.id))[0].relationship.defaultMode, 'expression');
    assert.deepEqual(await care.profiles(invitee.id), []);
    const invitation = await care.command(owner.id, profile.id, {
      action: 'invite',
      operationId: `invite-${suffix}`,
      permissions: ['read']
    });
    assert.equal((await care.accept(invitee.id, invitation.token)).id, profile.id);
    await care.command(invitee.id, profile.id, {
      action: 'relationship',
      operationId: `relationship-${suffix}`,
      value: { role: invitee.role }
    });
    const joined = await care.profiles(invitee.id);
    assert.deepEqual(joined.map(item => item.id), [profile.id]);
    assert.equal(joined[0].relationship.role, invitee.role);
    assert.equal(joined[0].relationship.defaultMode, 'receiver');
    assert.deepEqual(joined[0].permissions, ['read']);
    passed.push('self-service-email-registration-activation-login-and-care-invitation');

    // The actual NEV implementation renders a JSON-transport email. Its reset
    // URL stays in this in-process outbox and is not written to test output.
    outbox.length = 0;
    const forgot = await run(controller.forgotPassword, request({ email: owner.email }));
    assert.equal(forgot.code, 200);
    let resetMail = null;
    for (let attempt = 0; attempt < 20 && !resetMail; attempt += 1) {
      resetMail = outbox.find(message =>
        JSON.stringify(message.to).includes(owner.email) && String(message.text || '').includes('/reset/')
      );
      if (!resetMail) await new Promise(resolve => setImmediate(resolve));
    }
    assert(resetMail, 'forgot password must render a reset email in the JSON outbox');
    const resetLink = String(resetMail.text).match(
      /https:\/\/app\.example\.test\/reset\/([a-f0-9]{24})\/([a-f0-9]{64})/
    );
    assert(resetLink, 'reset email must contain the generated user id and opaque token');
    assert.equal(resetLink[1], owner.id);
    const newPassword = 'synthetic-reset-password';
    const stored = await run(controller.storePassword, request({
      userid: resetLink[1], token: resetLink[2], password: newPassword
    }));
    assert.equal(stored.code, 200);
    const replay = await run(controller.storePassword, request({
      userid: resetLink[1], token: resetLink[2], password: 'synthetic-replay-password'
    }));
    assert.equal(replay.code, 400, 'consumed reset link must not change the password again');

    const oldPasswordLogin = await run(controller.loginUser, request({
      email: owner.email, password
    }));
    assert.equal(oldPasswordLogin.code, 401);
    const resetLogin = await run(controller.loginUser, request({
      email: owner.email, password: newPassword
    }));
    assert.equal(resetLogin.code, 200);
    const authenticate = require('../../api/helpers/authenticateBearer').createBearerAuthenticator({
      auth,
      sessions,
      users: { getById: id => User.findById(id).lean().exec() }
    });
    assert.equal(await authenticate({ swagger: { operation: { 'x-security-scopes': [] } } },
      `Bearer ${owner.bearer}`), false, 'old device bearer must become unusable after reset');
    assert.equal(await authenticate({ swagger: { operation: { 'x-security-scopes': [] } } },
      `Bearer ${resetLogin.body.authToken}`), true);
    const stillOwned = await care.profiles(owner.id);
    assert.deepEqual(stillOwned.map(item => item.id), [profile.id]);
    passed.push('self-service-password-reset-rotates-login-and-preserves-care-authorization');

    const { resolveAuthRequestRateLimitConfig } = require('../../api/helpers/authRequestRateLimit');
    const limits = resolveAuthRequestRateLimitConfig();
    const mailCount = outbox.length;
    // This account already consumed one registration request above. Concurrent
    // retries exercise Mongo atomic counters through the real controller.
    const registrationRetries = await Promise.all(Array.from({
      length: limits.registration.emailHourlyLimit
    }, () => run(controller.createUser, request({
      name: 'Synthetic owner', email: owner.email, password
    }))));
    assert.equal(registrationRetries.filter(item => item.code === 200).length,
      limits.registration.emailHourlyLimit - 1);
    const deniedRegistration = registrationRetries.filter(item => item.code === 429);
    assert.equal(deniedRegistration.length, 1);
    assert.equal(deniedRegistration[0].body.error.code, 'USER_REGISTRATION_RATE_LIMITED');
    assert(Number(deniedRegistration[0].headers['Retry-After']) > 0);
    assert.equal(await User.countDocuments({ email: owner.email }), 1);
    assert.equal(await nev.options.tempUserModel.countDocuments({ email: owner.email }), 0);
    assert.equal(outbox.length, mailCount, 'existing-account retries must not send new activation mail');

    const resetRetries = await Promise.all(Array.from({
      length: limits.passwordReset.emailHourlyLimit
    }, () => run(controller.forgotPassword, request({ email: owner.email }))));
    assert.equal(resetRetries.filter(item => item.code === 200).length,
      limits.passwordReset.emailHourlyLimit - 1);
    const deniedReset = resetRetries.filter(item => item.code === 429);
    assert.equal(deniedReset.length, 1);
    assert.equal(deniedReset[0].body.error.code, 'PASSWORD_RESET_RATE_LIMITED');
    assert(Number(deniedReset[0].headers['Retry-After']) > 0);
    passed.push('self-service-concurrent-registration-and-reset-email-limits');

    const secondProfile = await care.createProfile(owner.id, {
      familyId: family.id, name: 'Synthetic second patient', role: 'relative'
    });
    assert.deepEqual((await care.profiles(invitee.id)).map(item => item.id), [profile.id]);
    await assert.rejects(care.transferAdmin(invitee.id, profile.id, {
      member: invitee.id, operationId: `self-promote-${suffix}`
    }), error => error.code === 'OWNER_REQUIRED');
    const transfer = { member: invitee.id, operationId: `transfer-${suffix}` };
    await care.transferAdmin(owner.id, profile.id, transfer);
    await care.transferAdmin(owner.id, profile.id, transfer);
    const administered = await care.profiles(invitee.id);
    assert.deepEqual(administered.map(item => item.id).sort(), [profile.id, secondProfile.id].sort());
    assert(administered.every(item => item.owner && item.permissions.includes('members.manage')));
    assert((await care.profiles(owner.id)).every(item => !item.owner && !item.permissions.includes('members.manage')));
    await assert.rejects(care.transferAdmin(owner.id, profile.id, {
      member: owner.id, operationId: `take-back-${suffix}`
    }), error => error.code === 'OWNER_REQUIRED');
    await care.command(invitee.id, secondProfile.id, {
      action: 'invite', operationId: `new-admin-invite-${suffix}`, permissions: ['read']
    });
    assert.equal((await care.profiles(owner.id)).find(item => item.id === profile.id).relationship.defaultMode,
      'expression', 'administrator transfer must not change the patient entry mode');
    passed.push('self-service-family-administrator-transfer-and-no-self-promotion');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    config.emailTransport = originalTransport;
    config.AUTH_EMAIL_APP_URL = originalOrigin;
    mockery.deregisterAll();
    mockery.disable();
    for (const [modulePath, value] of cached) {
      delete require.cache[modulePath];
      if (value) require.cache[modulePath] = value;
    }
  }
};

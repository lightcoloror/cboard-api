'use strict';
const assert = require('assert').strict;
const { validateDeploymentEmailConfiguration: validate } = require('../../scripts/checkProductionDeployment');

describe('deployment registration email configuration', () => {
  const configured = { EMAIL_FROM: 'Service <mail@synthetic.test>', SENDGRID_API_KEY: 'synthetic-only', AUTH_EMAIL_APP_URL: 'https://app.synthetic.test' };
  it('keeps mail optional for legacy deployments but requires it for public trial', () => {
    assert.deepEqual(validate({}), []);
    const errors = validate({ CARE_PUBLIC_TRIAL_ENABLED: 'true' });
    assert.equal(errors.length, 3);
    assert.ok(errors.some(value => value.includes('EMAIL_FROM')));
    assert.ok(errors.some(value => value.includes('SENDGRID_API_KEY')));
  });
  it('accepts the runtime origin fallback and explicit override', () => {
    assert.deepEqual(validate(configured), []);
    assert.deepEqual(validate({ ...configured, AUTH_EMAIL_APP_URL: '', CBOARD_APP_URL: configured.AUTH_EMAIL_APP_URL }), []);
  });
  it('rejects partial mail setup, invalid origins and header line breaks without exposing secrets', () => {
    assert.ok(validate({ SENDGRID_API_KEY: 'private-test-key' }).some(value => value.includes('EMAIL_FROM')));
    for (const origin of ['http://app.synthetic.test', 'https://app.synthetic.test/login', 'https://user:password@app.synthetic.test', 'https://app.synthetic.test?secret=value']) {
      const errors = validate({ ...configured, AUTH_EMAIL_APP_URL: origin });
      assert.equal(errors.length, 1);
      assert.ok(!errors.join(' ').includes(origin));
      assert.ok(!errors.join(' ').includes(configured.SENDGRID_API_KEY));
    }
    assert.ok(validate({ ...configured, EMAIL_FROM: 'sender\r\nInjected: value' }).some(value => value.includes('line breaks')));
  });
  it('rejects placeholder sender and provider credentials without echoing them', () => {
    for (const [key, value] of [
      ['EMAIL_FROM', 'Service <mail@example.com>'],
      ['SENDGRID_API_KEY', 'replace-with-a-real-api-key']
    ]) {
      const errors = validate({ ...configured, [key]: value });
      assert.ok(errors.some(error => error.includes(`${key} still contains a placeholder`)));
      assert.ok(!errors.join(' ').includes(value));
    }
  });
});

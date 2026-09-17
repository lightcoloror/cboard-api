'use strict';

const assert = require('assert').strict;
const YAML = require('yamljs');
const path = require('path');

function loadSpec() {
  return YAML.load(path.join(__dirname, '../../api/swagger/swagger.yaml'));
}

describe('care closure receipt Swagger contract', () => {
  it('documents authenticated receipt preparation with a strict redacted response', () => {
    const spec = loadSpec();
    const operation = spec.paths['/care/account/closure-receipt'].post;
    assert.equal(operation.operationId, 'prepareClosureReceipt');
    assert.deepEqual(operation.security, [{ Bearer: [] }]);
    assert.deepEqual(operation['x-security-scopes'], ['admin', 'user']);
    assert.equal(operation.responses['201'].schema.$ref, '#/definitions/ClosureReceiptPrepareResponse');
    assert.deepEqual(operation.responses['201'].headers['Cache-Control'].enum, ['no-store']);
    assert.equal(spec.definitions.ClosureReceiptPrepareResponse.additionalProperties, false);
    assert.deepEqual(spec.definitions.ClosureReceiptPrepareResponse.required,
      ['receiptId', 'secret', 'expiresAt']);
  });

  it('documents credential-only status without ordinary Bearer security', () => {
    const spec = loadSpec();
    const operation = spec.paths['/care/account/closure-status'].post;
    assert.equal(operation.operationId, 'inspectClosureReceipt');
    assert.deepEqual(operation.security, []);
    assert.equal(operation.parameters[0].schema.$ref, '#/definitions/ClosureReceiptStatusRequest');
    assert.equal(operation.responses['200'].schema.$ref, '#/definitions/ClosureReceiptStatusResponse');
    assert.deepEqual(operation.responses['200'].headers['Cache-Control'].enum, ['no-store']);
    assert.deepEqual(spec.definitions.ClosureReceiptStatusRequest.required,
      ['receiptId', 'secret']);
    assert.equal(spec.definitions.ClosureReceiptStatusRequest.additionalProperties, false);
    assert.deepEqual(spec.definitions.ClosureReceiptStatusResponse.properties.status.enum,
      ['prepared', 'confirmed']);
    assert.equal(spec.definitions.ClosureReceiptStatusResponse.properties.accountDeleted.type, 'boolean');
  });

  it('keeps status contract free of mutation or account-data capabilities', () => {
    const spec = loadSpec();
    const operation = spec.paths['/care/account/closure-status'].post;
    assert.match(operation.description, /cannot confirm, delete, or access account data/i);
    assert.equal(spec.definitions.ClosureReceiptStatusResponse.properties.secret, undefined);
    assert.equal(spec.definitions.ClosureReceiptStatusResponse.properties.sealed, undefined);
    assert.equal(spec.definitions.ClosureReceiptStatusResponse.properties.email, undefined);
  });
});

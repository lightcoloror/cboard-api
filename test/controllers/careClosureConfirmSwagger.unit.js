'use strict';

const assert = require('assert').strict;
const YAML = require('yamljs');
const path = require('path');

function loadSpec() {
  return YAML.load(path.join(__dirname, '../../api/swagger/swagger.yaml'));
}

describe('care closure confirmation Swagger contract', () => {
  it('requires authenticated user or admin confirmation with a strict body', () => {
    const spec = loadSpec();
    const operation = spec.paths['/care/account/closure-confirm'].post;
    assert.equal(operation.operationId, 'confirmClosure');
    assert.deepEqual(operation.security, [{ Bearer: [] }]);
    assert.deepEqual(operation['x-security-scopes'], ['admin', 'user']);
    assert.equal(operation.parameters[0].required, true);
    assert.equal(operation.parameters[0].schema.$ref, '#/definitions/ClosureConfirmRequest');
    assert.equal(spec.definitions.ClosureConfirmRequest.additionalProperties, false);
    assert.deepEqual(spec.definitions.ClosureConfirmRequest.required,
      ['familyIds', 'secret', 'confirmCloudDeletion']);
    assert.equal(spec.definitions.ClosureConfirmRequest.properties.familyIds.maxItems, 1000);
    assert.equal(spec.definitions.ClosureConfirmRequest.properties.familyIds.uniqueItems, true);
    assert.deepEqual(spec.definitions.ClosureConfirmRequest.properties.confirmCloudDeletion.enum, [true]);
  });

  it('documents accepted as incomplete with no-store and accountDeleted false', () => {
    const spec = loadSpec();
    const operation = spec.paths['/care/account/closure-confirm'].post;
    assert.equal(operation.responses['202'].schema.$ref, '#/definitions/ClosureConfirmAccepted');
    assert.deepEqual(operation.responses['202'].headers['Cache-Control'].enum, ['no-store']);
    assert.equal(spec.definitions.ClosureConfirmAccepted.additionalProperties, false);
    assert.deepEqual(spec.definitions.ClosureConfirmAccepted.properties.accountDeleted.enum, [false]);
    for (const code of ['400', '401', '404', '409', '429', '503']) {
      assert.ok(operation.responses[code], `missing ${code} response`);
    }
  });

  it('states the independent switch, revalidation, and nonterminal retry contract', () => {
    const description = loadSpec().paths['/care/account/closure-confirm'].post.description;
    assert.match(description, /independent confirmation switch/i);
    assert.match(description, /revalidated for every attempt/i);
    assert.match(description, /must not be interpreted as deletion completed/i);
  });
});

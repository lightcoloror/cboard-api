'use strict';
const assert = require('assert').strict;
const YAML = require('yamljs');
const path = require('path');
describe('care Swagger contract', () => {
  it('documents the creator usage role independently of permissions', () => {
    const spec = YAML.load(path.join(__dirname, '../../api/swagger/swagger.yaml'));
    const schema = spec.paths['/care/profiles'].post.parameters.find(p => p.in === 'body').schema;
    assert.deepEqual(schema.properties.role.enum, ['patient', 'relative', 'professional']);
    assert.equal(schema.properties.role.type, 'string');
  });
  it('documents both deletion routes without a user-content response', () => {
    const spec = YAML.load(path.join(__dirname, '../../api/swagger/swagger.yaml'));
    for (const route of ['/user/{id}', '/account/{id}']) {
      assert.equal(spec.paths[route].delete.responses['200'].schema.$ref, '#/definitions/DeleteAccountResponse');
    }
    assert.equal(spec.definitions.DeleteAccountResponse.properties.deletedCareAccount.type, 'integer');
  });
  it('parses with the deployed YAML parser and protects every care/session operation', () => {
    const spec = YAML.load(path.join(__dirname, '../../api/swagger/swagger.yaml'));
    for (const [route, item] of Object.entries(spec.paths)) {
      if (!route.startsWith('/care/') && route !== '/user/sessions') continue;
      for (const method of ['get', 'post', 'delete']) {
        if (!item[method]) continue;
        if (route === '/care/account/closure-status' && method === 'post') {
          assert.deepEqual(item[method].security, []);
          continue;
        }
        assert.deepEqual(item[method].security, [{ Bearer: [] }]);
        assert.equal(typeof item[method].operationId, 'string');
      }
    }
    assert.equal(spec.paths['/user/logout'].post.operationId, 'logoutUser');
    assert.equal(spec.paths['/user/logout'].post.parameters[0].required, false);
  });
});

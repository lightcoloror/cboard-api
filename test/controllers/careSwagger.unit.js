'use strict';
const assert = require('assert').strict;
const YAML = require('yamljs');
const path = require('path');
describe('care Swagger contract', () => {
  it('parses with the deployed YAML parser and protects every care/session operation', () => {
    const spec = YAML.load(path.join(__dirname, '../../api/swagger/swagger.yaml'));
    for (const [route, item] of Object.entries(spec.paths)) {
      if (!route.startsWith('/care/') && route !== '/user/sessions') continue;
      for (const method of ['get', 'post', 'delete']) {
        if (!item[method]) continue;
        assert.deepEqual(item[method].security, [{ Bearer: [] }]);
        assert.equal(typeof item[method].operationId, 'string');
      }
    }
    assert.equal(spec.paths['/user/logout'].post.operationId, 'logoutUser');
    assert.equal(spec.paths['/user/logout'].post.parameters[0].required, false);
  });
});

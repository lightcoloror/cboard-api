const assert = require('assert');
const fs = require('fs');
const yaml = require('js-yaml');
const spec = yaml.load(fs.readFileSync(require('path').join(__dirname, '../api/swagger/swagger.yaml'), 'utf8'));
assert.deepStrictEqual(spec.definitions.PictogramSemantics.properties.relation.enum, ['conflict', 'reviewed', 'unverified']);
assert.equal(spec.definitions.RuntimePictogram.properties.semantics.$ref, '#/definitions/PictogramSemantics');
assert.equal(spec.definitions.PictogramSemantics.properties.conceptId['x-nullable'], true);
console.log('Pictogram Swagger contract parsed and fields checked');

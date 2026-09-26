'use strict';

const fs = require('fs');
const { parseEnv } = require('./checkProductionDeployment');

function parseFieldList(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('fields are required');
  const fields = value.split(',').map(field => field.trim());
  if (fields.some(field => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field))) {
    throw new Error('invalid field name');
  }
  if (new Set(fields).size !== fields.length) throw new Error('duplicate field');
  return fields;
}

function readDeploymentEnvironment({ environmentPath, fields, json = false }) {
  if (typeof environmentPath !== 'string' || !environmentPath) throw new Error('environment file is required');
  const stat = fs.lstatSync(environmentPath);
  if (!stat.isFile()) throw new Error('environment file must be regular');
  const allowedFields = Array.isArray(fields) ? parseFieldList(fields.join(',')) : parseFieldList(fields);
  const values = parseEnv(fs.readFileSync(environmentPath, 'utf8'));
  const selected = {};
  for (const field of allowedFields) {
    if (!Object.prototype.hasOwnProperty.call(values, field)) throw new Error('requested field is missing');
    selected[field] = values[field];
  }
  return json ? JSON.stringify(selected) : allowedFields.map(field => `${field}=${selected[field]}`).join('\n');
}

function parseArgs(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--env-file') options.environmentPath = argv[++index];
    else if (arg === '--fields') options.fields = parseFieldList(argv[++index]);
    else if (arg === '--json') options.json = true;
    else throw new Error('unsupported argument');
  }
  if (!options.environmentPath || !options.fields) throw new Error('environment file and fields are required');
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  process.stdout.write(readDeploymentEnvironment(options));
}

if (require.main === module) {
  try {
    main();
  } catch (_) {
    process.stderr.write('deployment environment read failed\n');
    process.exitCode = 1;
  }
}

module.exports = { parseFieldList, readDeploymentEnvironment, parseArgs, main };

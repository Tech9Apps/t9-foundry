'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const Ajv = require('../node_modules/ajv');

const SCHEMAS = path.join(__dirname, '..', '..', 'schemas');
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(require(path.join(SCHEMAS, 'tracker-inputs.schema.json')));
ajv.addSchema(require(path.join(SCHEMAS, 'tracker-error.schema.json')));
const compiled = new Map();

function validator(name) {
  if (!compiled.has(name)) compiled.set(name, ajv.compile(require(path.join(SCHEMAS, `${name}.schema.json`))));
  return compiled.get(name);
}

function assertValid(schemaName, data) {
  const validate = validator(schemaName);
  if (!validate(data)) assert.fail(`${schemaName}: ${ajv.errorsText(validate.errors)}\n  got: ${JSON.stringify(data)}`);
}

function assertValidInput(op, data) {
  const validate = ajv.compile({ $ref: `tracker-inputs.schema.json#/definitions/${op}` });
  if (!validate(data)) assert.fail(`input for ${op}: ${ajv.errorsText(validate.errors)}`);
}

// assert.rejects with a TrackerError code (+ optional retriable flag)
function rejectsWith(promise, code, retriable) {
  return assert.rejects(promise, (err) => {
    assert.equal(err.name, 'TrackerError', `expected a TrackerError, got ${err && err.name}: ${err && err.message}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    if (retriable !== undefined) assert.equal(err.retriable, retriable);
    assertValid('tracker-error', err.toJSON());
    return true;
  });
}

module.exports = { assertValid, assertValidInput, rejectsWith };

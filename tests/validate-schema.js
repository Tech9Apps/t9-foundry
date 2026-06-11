#!/usr/bin/env node
// Validates a qa-config JSON file against qa-config.schema.json.
// Usage: node validate-schema.js <path-to-config.json>
// Exit 0 = valid, exit 1 = invalid, exit 2 = usage/runtime error.

const Ajv = require('ajv');
const fs = require('fs');
const path = require('path');

const schemaPath = path.join(__dirname, '..', 'qa-config.schema.json');
const dataPath = process.argv[2];

if (!dataPath) {
  console.error('Usage: node validate-schema.js <config-file.json>');
  process.exit(2);
}

let schema, data;
try {
  schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
} catch (err) {
  console.error('Error reading file:', err.message);
  process.exit(2);
}

const ajv = new Ajv({ allErrors: true });
const valid = ajv.validate(schema, data);

if (!valid) {
  ajv.errors.forEach(err => {
    const loc = err.instancePath || '(root)';
    console.error(`  ${loc}: ${err.message}`);
  });
  process.exit(1);
}

process.exit(0);

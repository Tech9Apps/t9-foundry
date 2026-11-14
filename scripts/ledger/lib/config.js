'use strict';

// The `ledger` block of qa-config.json (schema: qa-config.schema.json). Every key is optional; a command-line flag beats the config, and the
// config beats the default. Checked here with the schema's bounds so a bad value fails naming the key, like the triage block.
const { findConfig } = require('../../tracker/lib/connect');
const { usage, readJson } = require('../../lib/cli');

const DEFAULTS = { dir: '.qa-ledger', retentionDays: 90, keyRetentionDays: 400 };
const LIMITS = { retentionDays: [1, 3650] };
const KNOWN = ['dir', 'retentionDays'];

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function validate(block, where) {
  const b = block === undefined ? {} : block;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw usage(`${where}: "ledger" must be an object`);
  for (const k of Object.keys(b)) if (!KNOWN.includes(k)) throw usage(`${where}: unknown key "ledger.${k}" (known: ${KNOWN.join(', ')})`);
  if (b.dir !== undefined && !(typeof b.dir === 'string' && b.dir.length && !/[\u0000-\u001f\u007f]/u.test(b.dir))) throw usage(`${where}: "ledger.dir" must be a folder path`);
  if (b.retentionDays !== undefined && !isInt(b.retentionDays, ...LIMITS.retentionDays)) throw usage(`${where}: "ledger.retentionDays" must be a whole number from ${LIMITS.retentionDays[0]} to ${LIMITS.retentionDays[1]}`);
  return b;
}

// { file, dir, retentionDays, keyRetentionDays, explicit }. No config file at all is fine: everything is the default. `dir` is relative to
// the directory the command runs in, like every other output folder.
function ledgerConfig({ configPath, env = process.env } = {}) {
  const file = findConfig(configPath, env);
  let raw;
  if (file) {
    const doc = readJson(file, { fail: usage });
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw usage(`${file}: the config must be a JSON object`);
    raw = doc.ledger;
  }
  const v = validate(raw, file || 'qa-config.json');
  return {
    file: file || null,
    dir: v.dir === undefined ? DEFAULTS.dir : v.dir,
    retentionDays: v.retentionDays === undefined ? DEFAULTS.retentionDays : v.retentionDays,
    keyRetentionDays: DEFAULTS.keyRetentionDays,
    explicit: { dir: v.dir !== undefined, retentionDays: v.retentionDays !== undefined },
  };
}

module.exports = { ledgerConfig, validate, DEFAULTS, LIMITS, KNOWN };

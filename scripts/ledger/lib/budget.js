'use strict';

// The `budget` block of qa-config.json (schema: qa-config.schema.json): limits on a run, and how soon the same ticket may be run again. Every key is
// optional and 0 means "no limit". Only what the scripts themselves can SEE is enforced here (wall-clock time, the cooldown); turns and cost belong to
// whatever launches the model, which asks `ledger budget-check` what the project allows and passes it on (docs/phase-3-design.md, "Budgets").
const { findConfig } = require('../../tracker/lib/connect');
const { usage, readJson } = require('../../lib/cli');

const DEFAULTS = { maxWallClockMs: 0, maxTurns: 0, maxCostUsd: 0, cooldownMinutes: 0 };
// [min, max] for each setting; the loader, the command-line flags and qa-config.schema.json enforce these, and a test holds the schema to this table.
const LIMITS = { maxWallClockMs: [0, 7 * 24 * 60 * 60 * 1000], maxTurns: [0, 10000], maxCostUsd: [0, 100000], cooldownMinutes: [0, 7 * 24 * 60] };
const WHOLE = new Set(['maxWallClockMs', 'maxTurns', 'cooldownMinutes']);
const KNOWN = Object.keys(DEFAULTS);

const okValue = (key, v) => typeof v === 'number' && Number.isFinite(v) && v >= LIMITS[key][0] && v <= LIMITS[key][1] && (!WHOLE.has(key) || Number.isInteger(v));
const describe = (key) => `${WHOLE.has(key) ? 'a whole number' : 'a number'} from ${LIMITS[key][0]} to ${LIMITS[key][1]}`;

function validate(block, where) {
  const b = block === undefined ? {} : block;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw usage(`${where}: "budget" must be an object`);
  for (const k of Object.keys(b)) if (!KNOWN.includes(k)) throw usage(`${where}: unknown key "budget.${k}" (known: ${KNOWN.join(', ')})`);
  for (const k of KNOWN) if (b[k] !== undefined && !okValue(k, b[k])) throw usage(`${where}: "budget.${k}" must be ${describe(k)} (0 means no limit)`);
  return b;
}

// A flag may TIGHTEN what the project set, never lift it. A limit of 0 is "none", so any limit is tighter than 0; between two limits the smaller one wins.
const tighter = (configured, flagged) => (!flagged ? configured : !configured ? flagged : Math.min(configured, flagged));
// A cooldown is the other way round: a longer one is tighter.
const longer = (configured, flagged) => Math.max(configured, flagged || 0);

// { file, present, maxWallClockMs, maxTurns, maxCostUsd, cooldownMinutes, explicit }. A config that cannot be read is "no budget block" (the other
// loaders report it, as they always did); a malformed block is a usage error naming the key.
function budgetConfig({ configPath, env = process.env } = {}) {
  const file = findConfig(configPath, env);
  let raw;
  if (file) {
    let doc;
    try { doc = readJson(file, { fail: usage }); } catch { doc = undefined; }
    raw = doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc.budget : undefined;
  }
  const b = validate(raw, file || 'qa-config.json');
  const out = { file: file || null, present: raw !== undefined, explicit: {} };
  for (const k of KNOWN) { out[k] = b[k] === undefined ? DEFAULTS[k] : b[k]; out.explicit[k] = b[k] !== undefined; }
  return out;
}

module.exports = { budgetConfig, validate, tighter, longer, okValue, describe, DEFAULTS, LIMITS, KNOWN, WHOLE };

'use strict';

// The `triage` block of qa-config.json (schema: qa-config.schema.json). Every key is optional; a command-line flag
// beats the config, and the config beats the default. Values are checked here with the same bounds as the schema, so a
// bad one fails with a message that names the key instead of surfacing as odd behavior later.
const { findConfig } = require('../../tracker/lib/connect');
const { usage, readJson } = require('../../lib/cli');

// The raw formats scripts/results/normalize.js produces (a test checks this list against it and against qa-config.schema.json).
const FORMATS = ['junit', 'tap', 'playwright-json', 'jest-json'];
const DEFAULTS = {
  reruns: 2,
  confidenceThreshold: 0.8,
  // Runner formats whose classification has been verified on REAL failure output: only these may let a product-bug or test-bug verdict act.
  trustedFormats: ['tap'],
  selfHeal: { enabled: false, paths: null, maxFiles: 5, maxLines: 20, branchPrefix: 'qa/heal-' },
};
const MAX_RERUNS = 5;

// [min, max] for each whole-number setting. The config loader, the command-line flags (heal.js, orchestrate.js) and
// qa-config.schema.json all enforce these, and a test holds the schema to this table.
const LIMITS = { reruns: [0, MAX_RERUNS], maxFiles: [1, 20], maxLines: [1, 200] };
const PREFLIGHT_STATES = ['ok', 'failed', 'unknown'];

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isConfidence = (v) => typeof v === 'number' && v > 0 && v <= 1;

// The two flags classify.js and orchestrate.js both take.
function checkTriageFlags(opts) {
  if (opts.preflight && !PREFLIGHT_STATES.includes(opts.preflight)) throw usage('--preflight must be ok, failed or unknown');
  if (opts.threshold !== undefined && !isConfidence(opts.threshold)) throw usage('--threshold must be between 0 and 1');
}

function validate(triage, where) {
  const t = triage === undefined ? {} : triage; // null is NOT "absent": the schema rejects it, so the loader must too
  if (t === null || typeof t !== 'object' || Array.isArray(t)) throw usage(`${where}: "triage" must be an object`);
  const sh = t.selfHeal === undefined ? {} : t.selfHeal;
  if (typeof sh !== 'object' || sh === null || Array.isArray(sh)) throw usage(`${where}: "triage.selfHeal" must be an object`);
  const known = { triage: ['reruns', 'confidenceThreshold', 'trustedFormats', 'selfHeal'], selfHeal: ['enabled', 'paths', 'maxFiles', 'maxLines', 'branchPrefix'] };
  for (const k of Object.keys(t)) if (!known.triage.includes(k)) throw usage(`${where}: unknown key "triage.${k}" (known: ${known.triage.join(', ')})`);
  for (const k of Object.keys(sh)) if (!known.selfHeal.includes(k)) throw usage(`${where}: unknown key "triage.selfHeal.${k}" (known: ${known.selfHeal.join(', ')})`);
  if (t.reruns !== undefined && !isInt(t.reruns, ...LIMITS.reruns)) throw usage(`${where}: "triage.reruns" must be a whole number from ${LIMITS.reruns[0]} to ${LIMITS.reruns[1]}`);
  if (t.confidenceThreshold !== undefined && !isConfidence(t.confidenceThreshold)) throw usage(`${where}: "triage.confidenceThreshold" must be a number above 0 and at most 1`);
  if (t.trustedFormats !== undefined && !(Array.isArray(t.trustedFormats) && t.trustedFormats.every((f) => FORMATS.includes(f)) && new Set(t.trustedFormats).size === t.trustedFormats.length)) throw usage(`${where}: "triage.trustedFormats" must be a list of distinct formats from: ${FORMATS.join(', ')} (an empty list means nothing may act)`);
  if (sh.enabled !== undefined && typeof sh.enabled !== 'boolean') throw usage(`${where}: "triage.selfHeal.enabled" must be true or false`);
  if (sh.paths !== undefined && !(Array.isArray(sh.paths) && sh.paths.every((p) => typeof p === 'string' && p.length))) throw usage(`${where}: "triage.selfHeal.paths" must be a list of directory names`);
  if (sh.maxFiles !== undefined && !isInt(sh.maxFiles, ...LIMITS.maxFiles)) throw usage(`${where}: "triage.selfHeal.maxFiles" must be a whole number from ${LIMITS.maxFiles[0]} to ${LIMITS.maxFiles[1]}`);
  if (sh.maxLines !== undefined && !isInt(sh.maxLines, ...LIMITS.maxLines)) throw usage(`${where}: "triage.selfHeal.maxLines" must be a whole number from ${LIMITS.maxLines[0]} to ${LIMITS.maxLines[1]}`);
  if (sh.branchPrefix !== undefined && !(typeof sh.branchPrefix === 'string' && /^qa\/[A-Za-z0-9._-]*$/.test(sh.branchPrefix))) throw usage(`${where}: "triage.selfHeal.branchPrefix" must start with "qa/" and use only letters, digits, . _ -`);
  return { reruns: t.reruns, confidenceThreshold: t.confidenceThreshold, trustedFormats: t.trustedFormats, selfHeal: { ...sh } };
}

// Reads qa-config.json (explicit path, else the usual discovery) and returns the validated triage block merged over the
// defaults, plus where it came from. No config file at all is fine: everything is the default.
function triageConfig({ configPath, env = process.env } = {}) {
  const file = findConfig(configPath, env);
  let raw = {};
  let testDir;
  if (file) {
    const doc = readJson(file, { fail: usage });
    raw = doc.triage;
    testDir = (doc.testFramework || {}).testDir;
  }
  const where = file || 'qa-config.json';
  const v = validate(raw, where);
  return {
    file: file || null,
    reruns: v.reruns === undefined ? DEFAULTS.reruns : v.reruns,
    confidenceThreshold: v.confidenceThreshold === undefined ? DEFAULTS.confidenceThreshold : v.confidenceThreshold,
    trustedFormats: v.trustedFormats === undefined ? [...DEFAULTS.trustedFormats] : [...v.trustedFormats],
    selfHeal: {
      enabled: v.selfHeal.enabled === undefined ? DEFAULTS.selfHeal.enabled : v.selfHeal.enabled,
      paths: v.selfHeal.paths || (testDir ? [testDir] : DEFAULTS.selfHeal.paths),
      maxFiles: v.selfHeal.maxFiles === undefined ? DEFAULTS.selfHeal.maxFiles : v.selfHeal.maxFiles,
      maxLines: v.selfHeal.maxLines === undefined ? DEFAULTS.selfHeal.maxLines : v.selfHeal.maxLines,
      branchPrefix: v.selfHeal.branchPrefix === undefined ? DEFAULTS.selfHeal.branchPrefix : v.selfHeal.branchPrefix,
    },
    // which values were set explicitly (a flag may only override what is documented as overridable)
    explicit: { reruns: v.reruns !== undefined, confidenceThreshold: v.confidenceThreshold !== undefined, trustedFormats: v.trustedFormats !== undefined },
    explicitSelfHeal: v.selfHeal.enabled !== undefined,
  };
}

module.exports = { triageConfig, validate, DEFAULTS, MAX_RERUNS, FORMATS, LIMITS, isInt, isConfidence, checkTriageFlags };

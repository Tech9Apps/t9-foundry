'use strict';

// The `triage` block of qa-config.json (schema: qa-config.schema.json). Every key is optional; a command-line flag
// beats the config, and the config beats the default. Values are checked here with the same bounds as the schema, so a
// bad one fails with a message that names the key instead of surfacing as odd behavior later.
const fs = require('fs');
const { findConfig } = require('../../tracker/lib/connect');

const DEFAULTS = {
  reruns: 2,
  confidenceThreshold: 0.8,
  selfHeal: { enabled: false, paths: null, maxFiles: 5, maxLines: 20, branchPrefix: 'qa/heal-' },
};
const MAX_RERUNS = 5;

const usage = (message) => Object.assign(new Error(message), { isUsage: true });
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function validate(triage, where) {
  const t = triage || {};
  if (typeof t !== 'object' || Array.isArray(t)) throw usage(`${where}: "triage" must be an object`);
  const sh = t.selfHeal === undefined ? {} : t.selfHeal;
  if (typeof sh !== 'object' || sh === null || Array.isArray(sh)) throw usage(`${where}: "triage.selfHeal" must be an object`);
  const known = { triage: ['reruns', 'confidenceThreshold', 'selfHeal'], selfHeal: ['enabled', 'paths', 'maxFiles', 'maxLines', 'branchPrefix'] };
  for (const k of Object.keys(t)) if (!known.triage.includes(k)) throw usage(`${where}: unknown key "triage.${k}" (known: ${known.triage.join(', ')})`);
  for (const k of Object.keys(sh)) if (!known.selfHeal.includes(k)) throw usage(`${where}: unknown key "triage.selfHeal.${k}" (known: ${known.selfHeal.join(', ')})`);
  if (t.reruns !== undefined && !isInt(t.reruns, 0, MAX_RERUNS)) throw usage(`${where}: "triage.reruns" must be a whole number from 0 to ${MAX_RERUNS}`);
  if (t.confidenceThreshold !== undefined && !(typeof t.confidenceThreshold === 'number' && t.confidenceThreshold > 0 && t.confidenceThreshold <= 1)) throw usage(`${where}: "triage.confidenceThreshold" must be a number above 0 and at most 1`);
  if (sh.enabled !== undefined && typeof sh.enabled !== 'boolean') throw usage(`${where}: "triage.selfHeal.enabled" must be true or false`);
  if (sh.paths !== undefined && !(Array.isArray(sh.paths) && sh.paths.every((p) => typeof p === 'string' && p.length))) throw usage(`${where}: "triage.selfHeal.paths" must be a list of directory names`);
  if (sh.maxFiles !== undefined && !isInt(sh.maxFiles, 1, 20)) throw usage(`${where}: "triage.selfHeal.maxFiles" must be a whole number from 1 to 20`);
  if (sh.maxLines !== undefined && !isInt(sh.maxLines, 1, 200)) throw usage(`${where}: "triage.selfHeal.maxLines" must be a whole number from 1 to 200`);
  if (sh.branchPrefix !== undefined && !(typeof sh.branchPrefix === 'string' && /^qa\/[A-Za-z0-9._-]*$/.test(sh.branchPrefix))) throw usage(`${where}: "triage.selfHeal.branchPrefix" must start with "qa/" and use only letters, digits, . _ -`);
  return { reruns: t.reruns, confidenceThreshold: t.confidenceThreshold, selfHeal: { ...sh } };
}

// Reads qa-config.json (explicit path, else the usual discovery) and returns the validated triage block merged over the
// defaults, plus where it came from. No config file at all is fine: everything is the default.
function triageConfig({ configPath, env = process.env } = {}) {
  const file = findConfig(configPath, env);
  let raw = {};
  if (file) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw usage(`cannot read ${file}: ${e.message}`); }
    raw = doc.triage;
  }
  const where = file || 'qa-config.json';
  const v = validate(raw, where);
  const testDir = file ? (() => { try { return (JSON.parse(fs.readFileSync(file, 'utf8')).testFramework || {}).testDir; } catch { return undefined; } })() : undefined;
  return {
    file: file || null,
    reruns: v.reruns === undefined ? DEFAULTS.reruns : v.reruns,
    confidenceThreshold: v.confidenceThreshold === undefined ? DEFAULTS.confidenceThreshold : v.confidenceThreshold,
    selfHeal: {
      enabled: v.selfHeal.enabled === undefined ? DEFAULTS.selfHeal.enabled : v.selfHeal.enabled,
      paths: v.selfHeal.paths || (testDir ? [testDir] : DEFAULTS.selfHeal.paths),
      maxFiles: v.selfHeal.maxFiles === undefined ? DEFAULTS.selfHeal.maxFiles : v.selfHeal.maxFiles,
      maxLines: v.selfHeal.maxLines === undefined ? DEFAULTS.selfHeal.maxLines : v.selfHeal.maxLines,
      branchPrefix: v.selfHeal.branchPrefix === undefined ? DEFAULTS.selfHeal.branchPrefix : v.selfHeal.branchPrefix,
    },
    // which values were set explicitly (a flag may only override what is documented as overridable)
    explicit: { reruns: v.reruns !== undefined, confidenceThreshold: v.confidenceThreshold !== undefined },
    explicitSelfHeal: v.selfHeal.enabled !== undefined,
  };
}

module.exports = { triageConfig, validate, DEFAULTS, MAX_RERUNS };

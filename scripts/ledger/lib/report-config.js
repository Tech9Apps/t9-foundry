'use strict';

// The `report` block of qa-config.json (schema: qa-config.schema.json): which hosts a Slack webhook may point at besides hooks.slack.com. Optional; a malformed
// block is a usage error naming the key, an unreadable config is "no block" (the other loaders report that, as they always did).
const { findConfig } = require('../../tracker/lib/connect');
const { usage, readJson } = require('../../lib/cli');
const { HOST } = require('./slack');

const KNOWN = ['slackHosts'];
const MAX_HOSTS = 10;

function validate(block, where) {
  const b = block === undefined ? {} : block;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw usage(`${where}: "report" must be an object`);
  for (const k of Object.keys(b)) if (!KNOWN.includes(k)) throw usage(`${where}: unknown key "report.${k}" (known: ${KNOWN.join(', ')})`);
  if (b.slackHosts !== undefined && !(Array.isArray(b.slackHosts) && b.slackHosts.length <= MAX_HOSTS && b.slackHosts.every((h) => typeof h === 'string' && HOST.test(h)))) {
    throw usage(`${where}: "report.slackHosts" must be a list of at most ${MAX_HOSTS} host names in lower case (hooks.example.com), with no scheme, port or path`);
  }
  return b;
}

// { file, present, slackHosts }
function reportConfig({ configPath, env = process.env } = {}) {
  const file = findConfig(configPath, env);
  let raw;
  if (file) {
    let doc;
    try { doc = readJson(file, { fail: usage }); } catch { doc = undefined; }
    raw = doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc.report : undefined;
  }
  const b = validate(raw, file || 'qa-config.json');
  return { file: file || null, present: raw !== undefined, slackHosts: b.slackHosts || [] };
}

module.exports = { reportConfig, validate, KNOWN, MAX_HOSTS };

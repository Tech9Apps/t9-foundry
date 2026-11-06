'use strict';

const fs = require('fs');
const path = require('path');
const { TrackerError } = require('./errors');
const { createAdapter, SUPPORTED } = require('../adapters');

// Where qa-config.json lives: explicit path, else $CLAUDE_PROJECT_DIR, else the cwd and its parents.
function findConfig(explicit, env) {
  if (explicit) return explicit;
  const candidates = [];
  if (env.CLAUDE_PROJECT_DIR) candidates.push(path.join(env.CLAUDE_PROJECT_DIR, 'qa-config.json'));
  candidates.push('qa-config.json', '../qa-config.json', '../../qa-config.json');
  return candidates.find((c) => fs.existsSync(c));
}

// Resolve config + credentials into a ready adapter. Fails fast (CONFIG) before any request.
function connect({ configPath, source, baseUrl, timeoutMs, env = process.env, fetch = globalThis.fetch }) {
  const file = findConfig(configPath, env);
  let config = {};
  if (file) {
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new TrackerError('CONFIG', `cannot read ${file}: ${e.message}`); }
  } else if (!source) {
    throw new TrackerError('CONFIG', 'no qa-config.json found and no --source given — run /init or pass --config');
  }
  const type = source || (config.ticketSource && config.ticketSource.type);
  if (!type || type === 'none') {
    throw new TrackerError('CONFIG', `ticketSource.type is "${type || 'unset'}" — there is no tracker to talk to (supported: ${SUPPORTED.join(', ')})`);
  }
  return createAdapter(type, {
    settings: (config.ticketSource && config.ticketSource[type]) || {},
    env,
    fetch,
    baseUrl: baseUrl || env.QA_TRACKER_BASE_URL || undefined,
    timeoutMs: timeoutMs || undefined,
  });
}

module.exports = { findConfig, connect };

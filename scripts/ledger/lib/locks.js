'use strict';

// Run locks: two runs must not hammer one test environment, and two runs must not work one ticket at once (docs/phase-3-design.md, "Locks"). The lock
// files and the stale-lock rules are in ledger.js (acquireLock); this is the part a command needs: which scopes a run takes, taking them all or none,
// and letting go however the run ends, including when it is killed.
const { findConfig } = require('../../tracker/lib/connect');
const { readJson, usage } = require('../../lib/cli');

// "https://Staging.Example.com:443/app/?x=1#y" -> "https://staging.example.com/app": the same environment however it was typed. null when it is not a URL.
function normalizeEnvUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
}

// The scopes a run takes: the environment under test (when the project names one) and the ticket (when the run is for one). Sorted, so that two runs
// wanting the same two locks ask for them in the same order and cannot each hold one of them while waiting for the other.
function scopesFor({ envUrl, ticket }) {
  const out = [];
  const env = envUrl ? normalizeEnvUrl(envUrl) : null;
  if (env) out.push(`env:${env}`);
  if (ticket) out.push(`ticket:${String(ticket)}`);
  return out.sort();
}

// testEnvironmentBaseUrl from the project's config, or undefined (no config, an unreadable one, or none named).
function configEnvUrl({ configPath, env = process.env }) {
  const file = findConfig(configPath, env);
  if (!file) return undefined;
  try { const doc = readJson(file, { fail: usage }); return doc && typeof doc === 'object' && typeof doc.testEnvironmentBaseUrl === 'string' ? doc.testEnvironmentBaseUrl : undefined; } catch { return undefined; }
}

// All of the scopes, or none: { ok: true, release } or { ok: false, scope, holder, reason }. A lock already taken is given back if a later one is refused.
function acquireAll(ledger, scopes, { runId, ttlMs } = {}) {
  const held = [];
  const releaseAll = () => { for (const h of held.splice(0).reverse()) { try { h.release(); } catch { /* a lock that is already gone */ } } };
  for (const scope of scopes) {
    const got = ledger.acquireLock(scope, { runId, ...(ttlMs ? { ttlMs } : {}) });
    if (!got.acquired) { releaseAll(); return { ok: false, scope, holder: got.holder, reason: got.reason }; }
    held.push(got);
  }
  return { ok: true, scopes, release: releaseAll, stole: held.filter((h) => h.stole).map((h) => h.lock.scope) };
}

// Let go of the locks when the process is told to stop (SIGINT, SIGTERM, SIGHUP). The order matters:
//   1. stop what the run started (`stopWork`: a test runner left going would keep hitting the environment AFTER the lock that protects it was given up);
//   2. give the locks back;
//   3. stop handling the signal and send it again to this process, so it ends the way it would have without us (and so that a handler that was added
//      AFTER this one, like self-heal's revert, still gets the same signal in the same turn and does its own work: this handler never exits the process itself).
// Returns a function that removes the handlers (the run finished normally).
function guardSignals({ release, stopWork, proc = process }) {
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((sig) => [sig, () => {
    try { if (stopWork) stopWork(); } catch { /* nothing running */ }
    try { release(); } catch { /* best effort: a lock left behind by a dead process is stolen by the next run */ }
    disarm();
    proc.kill(proc.pid, sig);
  }]);
  function disarm() { for (const [sig, h] of handlers) proc.removeListener(sig, h); }
  for (const [sig, h] of handlers) proc.on(sig, h);
  return disarm;
}

module.exports = { normalizeEnvUrl, scopesFor, configEnvUrl, acquireAll, guardSignals };

'use strict';

// Run locks: two runs must not hammer one test environment, and two runs must not work one ticket at once (docs/phase-3-design.md, "Locks"). The lock
// files and the stale-lock rules are in ledger.js (acquireLock); this is the part a command needs: which scopes a run takes, taking them all or none,
// and letting go however the run ends, including when it is killed.
const { findConfig } = require('../../tracker/lib/connect');
const { readJson, usage } = require('../../lib/cli');
const { isValidRunId } = require('../../lib/ids');
const { redactSecrets } = require('../../triage/lib/text');
const { DEFAULT_LOCK_TTL_MS } = require('./ledger');

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

// environments.testEnvironmentBaseUrl from the project's config (where qa-config.schema.json puts it), or undefined (no config, an unreadable one, or none named).
function configEnvUrl({ configPath, env = process.env }) {
  const file = findConfig(configPath, env);
  if (!file) return undefined;
  try {
    const doc = readJson(file, { fail: usage });
    const url = doc && typeof doc === 'object' && doc.environments && typeof doc.environments === 'object' ? doc.environments.testEnvironmentBaseUrl : undefined;
    return typeof url === 'string' ? url : undefined;
  } catch { return undefined; }
}

// What is wrong with a ticket id, or null. It becomes a lock scope and a ledger field: 1-128 printable characters, and not something that looks like a credential
// (the ledger refuses those, and a ticket recorded as <redacted> could never match its own cooldown).
function ticketProblem(ticket) {
  if (!isValidRunId(ticket)) return 'must be 1-128 characters with no control characters';
  if (redactSecrets(ticket) !== ticket) return 'looks like a credential, which the ledger refuses to record';
  return null;
}

// How long a run's locks last before another run may take them over as expired. The owner's process being gone is what normally frees a lock; the TTL is the
// backstop for an owner on another machine, and it must not run out under a run that is still working (that silently ends the mutual exclusion). A run takes
// the main run, each re-run and the self-heal validation, each up to `timeoutMs`; a wall-clock limit is only checked BEFORE a step, so it adds one step at most.
const DEFAULT_STEP_MS = 30 * 60 * 1000; // results/run.js's own default timeout
const LOCK_MARGIN_MS = 10 * 60 * 1000;
function runLockTtlMs({ reruns = 2, timeoutMs, maxWallClockMs } = {}) {
  const step = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_STEP_MS;
  const bound = (Math.max(0, Number(reruns) || 0) + 2) * step + LOCK_MARGIN_MS;
  if (maxWallClockMs > 0) return Math.min(bound, maxWallClockMs + step + LOCK_MARGIN_MS);
  return Math.max(DEFAULT_LOCK_TTL_MS, bound);
}

// All of the scopes, or none: { ok: true, release } or { ok: false, scope, holder, reason }. A lock already taken is given back if a later one is refused.
function acquireAll(ledger, scopes, { runId, ttlMs } = {}) {
  const held = [];
  const releaseAll = () => { for (const h of held.splice(0).reverse()) { try { h.release(); } catch { /* a lock that is already gone */ } } };
  try {
    for (const scope of scopes) {
      const got = ledger.acquireLock(scope, { runId, ...(ttlMs ? { ttlMs } : {}) });
      if (!got.acquired) { releaseAll(); return { ok: false, scope, holder: got.holder, reason: got.reason }; }
      held.push(got);
    }
  } catch (e) { releaseAll(); throw e; } // a later scope that cannot be taken at all must not leave the earlier ones behind, with nobody to give them back
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

module.exports = { normalizeEnvUrl, scopesFor, configEnvUrl, ticketProblem, runLockTtlMs, acquireAll, guardSignals };

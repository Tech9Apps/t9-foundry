'use strict';

// The run ledger: what each run did, kept as plain files so a crash, a retry or a second run can see it. The design, and why it is
// shaped like this, is docs/phase-3-design.md ("The ledger", "Idempotency and resume", "Locks").
//
//   <dir>/VERSION                schema version ("1")
//   <dir>/runs/<run>.jsonl       one run's events, appended by that run only
//   <dir>/keys/<hash>.json       one idempotency claim per file, created with O_EXCL (the one atomic compare-and-set a filesystem has)
//   <dir>/locks/<hash>.lock      one lock per scope, same trick
//   <dir>/audit.jsonl            external writes and proposals, and lock steals, from every run
//
// Three rules the rest of the code relies on:
//   * Reading never throws on a damaged ledger: a torn line, an unknown record type or a newer VERSION is a warning.
//   * Writing is narrow: every record is validated against TYPES, secret-masked and size-capped; files are 0600 and the folders 0700.
//   * The ledger can only SUPPRESS (a key already done, a lock held) or RECORD. Nothing here ever grants permission to act.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { codedError } = require('../../lib/cli');
const { sanitize, runPart } = require('../../lib/ids');
const { redactSecrets } = require('../../triage/lib/text');

const VERSION = 1;
const MAX_RECORD_BYTES = 8192;
const MAX_STRING = 200; // what an over-long string is cut to when a record has to be shrunk to fit
const MAX_KEY_LENGTH = 200;
const DEFAULT_LOCK_TTL_MS = 2 * 60 * 60 * 1000;
const UNREADABLE_LOCK_GRACE_MS = 60 * 1000; // a lock file with nothing readable in it is a writer mid-write, until it has been that way this long
const DAY_MS = 24 * 60 * 60 * 1000;
const GUARD_STALE_MS = 60 * 1000; // a takeover guard older than this belongs to a process that died holding it

// Every record is { v, ts, runId, type, ...fields }. A field is 'string' | 'number' | 'boolean' | 'object' | 'array', or a list of the
// strings it may be; a trailing '?' makes it optional. Fields not listed are refused, so the schema (schemas/ledger-record.schema.json,
// which a test holds to this table) is the whole truth about what a record can contain.
const TYPES = {
  'run.start': { framework: 'string?', source: 'string?', ticket: 'string?', pid: 'number', host: 'string', config: 'object?' },
  'test.result': { spec: 'string', name: 'string', status: 'string', phase: 'string', durationMs: 'number?' },
  verdict: { token: 'string', class: 'string', confidence: 'number', action: 'string', step: 'string?' },
  'action.claimed': { key: 'string', step: 'string', target: 'string?' },
  'action.done': { key: 'string', id: 'string?', url: 'string?', deduplicated: 'boolean?' },
  'action.failed': { key: 'string', code: 'string', message: 'string?' },
  'heal.begin': { branch: 'string', baseSha: 'string', token: 'string?' },
  'heal.end': { branch: 'string', outcome: ['kept', 'reverted', 'interrupted'] },
  budget: { wallClockMs: 'number?', turns: 'number?', costUsd: 'number?', exceeded: 'string?' },
  'run.end': { exit: 'number', complete: 'boolean', counts: 'object?' },
  'lock.stolen': { scope: 'string', reason: 'string', previousRunId: 'string?', previousPid: 'number?' },
};
const ENVELOPE = { v: 'number', ts: 'string', runId: 'string', type: Object.keys(TYPES), truncated: 'boolean?' };
// What a finished claim carries as its result: the same three fields action.done does.
const RESULT = { id: 'string?', url: 'string?', deduplicated: 'boolean?' };

const kindOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

// Checks `rec` against a field table. Returns a message, or null when it fits.
function checkFields(rec, table, what) {
  for (const k of Object.keys(rec)) if (!Object.hasOwn(table, k)) return `${what}: unknown field "${k}"`;
  for (const [k, spec] of Object.entries(table)) {
    const optional = typeof spec === 'string' && spec.endsWith('?');
    if (rec[k] === undefined) {
      if (optional) continue;
      return `${what}: "${k}" is required`;
    }
    if (Array.isArray(spec)) {
      if (!spec.includes(rec[k])) return `${what}: "${k}" must be one of ${spec.join(', ')}`;
      continue;
    }
    const want = optional ? spec.slice(0, -1) : spec;
    const got = kindOf(rec[k]);
    const ok = want === 'number' ? got === 'number' && Number.isFinite(rec[k]) : want === got;
    if (!ok) return `${what}: "${k}" must be a ${want}`;
  }
  return null;
}

function validateRecord(rec) {
  if (kindOf(rec) !== 'object') return 'record is not an object';
  const known = TYPES[rec.type];
  if (!known) return `unknown record type ${JSON.stringify(String(rec.type).slice(0, 40))}`;
  const { v, ts, runId, type, truncated, ...fields } = rec;
  return checkFields({ v, ts, runId, type, truncated }, ENVELOPE, `${rec.type}`) || checkFields(fields, known, `${rec.type}`);
}

// Everything that reaches a file passes through the same masking the triage report uses: a failure message can carry a token.
function mask(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (k !== '__proto__') out[k] = mask(v);
    return out;
  }
  return value;
}

function shrinkStrings(value) {
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (Array.isArray(value)) return value.map(shrinkStrings);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrinkStrings(v)]));
  return value;
}

// One line, at most MAX_RECORD_BYTES. A record that is too big is shrunk, never dropped: long strings are cut first, then the biggest
// object and array fields are emptied, and the record says it was truncated.
function fitRecord(rec) {
  const size = (r) => Buffer.byteLength(JSON.stringify(r));
  if (size(rec) <= MAX_RECORD_BYTES) return rec;
  let out = { ...shrinkStrings(rec), truncated: true };
  const bulky = Object.entries(out).filter(([, v]) => v && typeof v === 'object').sort((a, b) => size(b[1]) - size(a[1]));
  for (const [k, v] of bulky) {
    if (size(out) <= MAX_RECORD_BYTES) break;
    out = { ...out, [k]: Array.isArray(v) ? [] : {} };
  }
  return out;
}

const sha = (s, n) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n);

// A run's file stem. runPart makes any id safe and keeps two different ids apart; this also keeps them apart on a case-insensitive
// disk (macOS): an id with an upper-case letter gets a hash of the whole id, so "A" and "a" cannot share a file.
function stemOf(runId) {
  const part = runPart(runId);
  return part === part.toLowerCase() ? part : `${sanitize(runId).toLowerCase().slice(0, 24)}-${sha(runId, 12)}`;
}

function assertKey(key) {
  if (typeof key !== 'string' || !key.length || key.length > MAX_KEY_LENGTH || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw codedError('LEDGER_INVALID', `a key is 1-${MAX_KEY_LENGTH} printable characters`);
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Parses the JSONL text of one file. Never throws: what cannot be used becomes a warning.
function parseEvents(text, label) {
  const events = [];
  const warnings = [];
  const lines = text.split('\n');
  const tornTail = lines.length && lines[lines.length - 1] !== ''; // the file does not end with a newline: the last write was cut off
  let unknown = 0;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let rec;
    try { rec = JSON.parse(line); } catch {
      warnings.push(i === lines.length - 1 && tornTail ? `${label}: torn final line skipped (a write was cut off)` : `${label}: line ${i + 1} is not valid JSON, skipped`);
      return;
    }
    if (kindOf(rec) === 'object' && typeof rec.type === 'string' && !TYPES[rec.type]) { unknown += 1; return; } // a newer writer's record
    const bad = validateRecord(rec);
    if (bad) { warnings.push(`${label}: line ${i + 1} skipped (${bad})`); return; }
    events.push(rec);
  });
  if (unknown) warnings.push(`${label}: ${unknown} record${unknown === 1 ? '' : 's'} of a type this version does not know, skipped`);
  return { events, warnings };
}

function openLedger({ dir, now = Date.now, pid = process.pid, host = os.hostname() } = {}) {
  if (!dir) throw codedError('LEDGER_INVALID', 'a ledger needs a directory');
  const root = path.resolve(dir);
  const p = (...parts) => path.join(root, ...parts);
  const iso = () => new Date(now()).toISOString();
  let ready = false;

  const readVersion = () => {
    try { return fs.readFileSync(p('VERSION'), 'utf8').trim(); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  };
  // null when this code may read and write the ledger; otherwise why not (a newer layout than this code understands)
  const versionProblem = () => {
    const found = readVersion();
    return found === null || found === String(VERSION) ? null : `ledger layout version ${JSON.stringify(found.slice(0, 20))} is not one this code understands (it writes ${VERSION}): reading only`;
  };

  // The first write creates the folders (0700) and the VERSION file; a newer VERSION makes every write refuse.
  function init() {
    if (ready) return;
    for (const sub of ['', 'runs', 'keys', 'locks']) fs.mkdirSync(p(sub), { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(p('VERSION'), `${VERSION}\n`, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const problem = versionProblem();
    if (problem) throw codedError('LEDGER_VERSION', problem);
    ready = true;
  }

  const build = (runId, type, fields) => {
    if (typeof runId !== 'string' || !runId.length) throw codedError('LEDGER_INVALID', 'a record needs a run id');
    for (const k of Object.keys(ENVELOPE)) if (Object.hasOwn(fields, k)) throw codedError('LEDGER_INVALID', `${type}: "${k}" belongs to the record envelope, not its fields`);
    const rec = fitRecord({ v: VERSION, ts: iso(), runId, type, ...mask(fields) });
    const bad = validateRecord(rec);
    if (bad) throw codedError('LEDGER_INVALID', bad);
    return rec;
  };
  // Runs fn() while holding `<file>.guard` (created with O_EXCL), so that only one caller at a time may REPLACE a failed claim or a stale lock.
  // Replacing is done by writing the new content to a temp file and renaming it over the old one, so the path is never empty: a third caller
  // creating the file at that moment (which is how everyone else claims) can only ever lose. { guarded: false } means somebody else holds the
  // guard. A guard older than a minute is a dead holder's and is removed once; that narrow case (a crash exactly there) is a documented limit.
  function withGuard(file, fn) {
    const guard = `${file}.guard`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { fs.closeSync(fs.openSync(guard, 'wx', 0o600)); } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let st;
        try { st = fs.statSync(guard); } catch (e2) { if (e2.code === 'ENOENT') continue; throw e2; }
        if (now() - st.mtimeMs > GUARD_STALE_MS) { fs.rmSync(guard, { force: true }); continue; }
        return { guarded: false };
      }
      try { return { guarded: true, value: fn() }; } finally { fs.rmSync(guard, { force: true }); }
    }
    return { guarded: false };
  }
  const append = (file, rec) => fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });

  // ---- events --------------------------------------------------------------------------------------------------------------------
  function record(runId, type, fields = {}) {
    init();
    const rec = build(runId, type, fields);
    append(p('runs', `${stemOf(runId)}.jsonl`), rec);
    return rec;
  }
  function audit(runId, type, fields = {}) {
    init();
    const rec = build(runId, type, fields);
    append(p('audit.jsonl'), rec);
    return rec;
  }
  const readFile = (file, label) => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { events: [], warnings: [] }; throw e; }
    return parseEvents(text, label);
  };
  function readRun(runId) {
    const { events, warnings } = readFile(p('runs', `${stemOf(runId)}.jsonl`), `run ${runId}`);
    const mine = events.filter((e) => e.runId === runId); // a stem shared by two ids would be a bug in stemOf; never mix their events
    const problem = versionProblem();
    return { runId, events: mine, warnings: problem ? [problem, ...warnings] : warnings, finished: mine.some((e) => e.type === 'run.end') };
  }
  const readAudit = () => readFile(p('audit.jsonl'), 'audit');

  function listRuns() {
    let names;
    try { names = fs.readdirSync(p('runs')).filter((n) => n.endsWith('.jsonl')).sort(); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return names.map((n) => {
      const { events } = readFile(p('runs', n), n);
      const first = events[0];
      const end = events.find((e) => e.type === 'run.end');
      return { runId: first ? first.runId : null, file: n, events: events.length, startedAt: first ? first.ts : null, finished: Boolean(end), endedAt: end ? end.ts : null, complete: end ? end.complete : null };
    });
  }

  // ---- idempotency keys ----------------------------------------------------------------------------------------------------------
  const keyPath = (key) => p('keys', `${sha(key, 32)}.json`);
  // The claim for a key: its record when readable, { state: 'in-flight' } when the file exists but is empty or torn (a writer is mid-write
  // or died there: the key IS taken), null when nobody has claimed it.
  function readClaim(key) {
    assertKey(key);
    let text;
    try { text = fs.readFileSync(keyPath(key), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    let rec;
    try { rec = JSON.parse(text); } catch { return { key, state: 'claimed', unreadable: true }; }
    if (kindOf(rec) !== 'object') return { key, state: 'claimed', unreadable: true };
    if (rec.key !== key) throw codedError('LEDGER_KEY_COLLISION', `the claim file for this key holds a different key (${JSON.stringify(String(rec.key).slice(0, 60))})`);
    return rec;
  }
  const ownerAlive = (claim) => (claim.host === host && Number.isInteger(claim.pid) ? pidAlive(claim.pid) : null); // null: another machine, cannot tell
  const writeClaimAtomically = (key, rec) => {
    const file = keyPath(key);
    const tmp = `${file}.tmp-${pid}-${sha(`${now()}${Math.random()}`, 8)}`;
    fs.writeFileSync(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file); // never leave a half-written claim behind a crash
  };
  const tryCreateClaim = (key, rec) => {
    let fd;
    try { fd = fs.openSync(keyPath(key), 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    try { fs.writeSync(fd, `${JSON.stringify(rec)}\n`); } finally { fs.closeSync(fd); }
    return true;
  };

  // Exactly one caller wins a key. A lost claim says why: the key is `done` (skip it: result is the recorded one), or `in-flight` (claimed
  // and not finished: the writer may be running, or may have died after the remote write, which is for the caller to reconcile).
  // A `failed` claim may be taken over; two callers racing for it still produce exactly one winner (rename is atomic).
  function claim(key, { runId } = {}) {
    init();
    assertKey(key);
    const mine = { v: VERSION, key, runId: runId || null, state: 'claimed', claimedAt: iso(), pid, host };
    if (tryCreateClaim(key, mine)) return { won: true, claim: mine };
    let cur = readClaim(key);
    if (cur && cur.state === 'failed') {
      // Only one caller at a time may replace a failed claim, and only if it is still the failed claim we looked at: another caller may have
      // taken it over (and written a fresh claim) since.
      const r = withGuard(keyPath(key), () => {
        const again = readClaim(key);
        if (!again || again.state !== 'failed' || again.completedAt !== cur.completedAt) return false;
        writeClaimAtomically(key, { ...mine, previousFailure: cur.error || null });
        return true;
      });
      if (r.guarded && r.value) return { won: true, claim: mine, tookOverFailed: true };
      cur = readClaim(key);
    }
    if (!cur) return claim(key, { runId }); // it vanished between the two looks (pruned or taken over): look again
    return { won: false, state: cur.state === 'done' ? 'done' : 'in-flight', claim: cur, ownerAlive: cur.state === 'done' ? null : ownerAlive(cur) };
  }

  function finish(key, state, extra) {
    init();
    assertKey(key);
    const cur = readClaim(key);
    if (!cur) throw codedError('LEDGER_NO_CLAIM', `no claim for this key: claim it first`);
    if (cur.state === 'done') return { changed: false, claim: cur };
    if (cur.state === 'failed' && state === 'failed') return { changed: false, claim: cur };
    const next = { ...(cur.unreadable ? { v: VERSION, key } : cur), state, completedAt: iso(), ...extra };
    writeClaimAtomically(key, next);
    return { changed: true, claim: next };
  }
  function complete(key, result = {}) {
    const bad = checkFields(result, RESULT, 'result');
    if (bad) throw codedError('LEDGER_INVALID', bad);
    return finish(key, 'done', { result: mask(result) });
  }
  function fail(key, { code, message } = {}) {
    if (typeof code !== 'string' || !code) throw codedError('LEDGER_INVALID', 'a failure needs a code');
    const error = { code: String(mask(code)).slice(0, 80), ...(message === undefined ? {} : { message: String(mask(message)).slice(0, 300) }) };
    return finish(key, 'failed', { error });
  }
  function listKeys() {
    let names;
    try { names = fs.readdirSync(p('keys')).filter((n) => n.endsWith('.json')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return names.map((n) => {
      let rec;
      try { rec = JSON.parse(fs.readFileSync(p('keys', n), 'utf8')); } catch { rec = null; }
      if (kindOf(rec) !== 'object') return { file: n, key: null, state: 'claimed', unreadable: true };
      return { file: n, key: rec.key, runId: rec.runId, state: rec.state, claimedAt: rec.claimedAt, completedAt: rec.completedAt, ownerAlive: rec.state === 'claimed' ? ownerAlive(rec) : null };
    });
  }

  // ---- locks ---------------------------------------------------------------------------------------------------------------------
  const lockPath = (scope) => p('locks', `${sha(scope, 32)}.lock`);
  function readLock(file) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      try { const rec = JSON.parse(text); return kindOf(rec) === 'object' ? { holder: rec } : { holder: null, mtime: fs.statSync(file).mtimeMs }; } catch { return { holder: null, mtime: fs.statSync(file).mtimeMs }; }
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  // Why a lock may be taken from its holder, or null when it may not. A lock with nothing readable in it is a writer mid-write until it has
  // been that way for a minute.
  function staleReason(seen) {
    const { holder, mtime } = seen;
    if (!holder) return now() - mtime > UNREADABLE_LOCK_GRACE_MS ? 'the lock file was never completed' : null;
    if (holder.host === host && Number.isInteger(holder.pid) && !pidAlive(holder.pid)) return 'its owner process is gone';
    const started = Date.parse(holder.startedAt);
    if (Number.isFinite(started) && Number.isFinite(holder.ttlMs) && now() - started > holder.ttlMs) return 'it expired';
    return null;
  }
  const sameHolder = (a, b) => a && b && a.pid === b.pid && a.host === b.host && a.runId === b.runId && a.startedAt === b.startedAt;
  const createLock = (file, info) => {
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    try { fs.writeSync(fd, `${JSON.stringify(info)}\n`); } finally { fs.closeSync(fd); }
    return true;
  };

  // { acquired: true, release } or { acquired: false, holder, reason }. A stale lock (owner dead on this machine, or past its TTL) is
  // stolen, and the steal is audited. The takeover is guarded and atomic (see withGuard), so two runs stealing at once cannot each remove the
  // other's fresh lock. What is left, and documented: a live owner whose TTL ran out can still release at the very moment it is replaced.
  function acquireLock(scope, { runId, ttlMs = DEFAULT_LOCK_TTL_MS } = {}) {
    init();
    if (typeof scope !== 'string' || !scope.length) throw codedError('LEDGER_INVALID', 'a lock needs a scope');
    if (typeof runId !== 'string' || !runId.length) throw codedError('LEDGER_INVALID', 'a lock needs a run id');
    const file = lockPath(scope);
    const info = { v: VERSION, scope, runId, pid, host, startedAt: iso(), ttlMs };
    const release = () => {
      const seen = readLock(file);
      if (seen && sameHolder(seen.holder, info)) fs.rmSync(file, { force: true }); // only our own: after a steal the file is someone else's
    };
    if (createLock(file, info)) return { acquired: true, release, lock: info };
    const seen = readLock(file);
    if (!seen) return acquireLock(scope, { runId, ttlMs }); // released between the two looks
    const reason = staleReason(seen);
    if (!reason) return { acquired: false, holder: seen.holder, reason: 'held' };
    // Take it over under the guard, and only if it is still the lock we judged stale (another run may have stolen it and written a fresh one).
    const stolen = withGuard(file, () => {
      const again = readLock(file);
      if (!again) return { outcome: 'gone' };
      if (seen.holder ? !sameHolder(again.holder, seen.holder) : again.holder) return { outcome: 'changed', holder: again.holder };
      const tmp = `${file}.tmp-${pid}-${sha(`${now()}${Math.random()}`, 8)}`;
      fs.writeFileSync(tmp, `${JSON.stringify(info)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
      return { outcome: 'stolen' };
    });
    if (!stolen.guarded) return { acquired: false, holder: seen.holder, reason: 'being taken over by another run' };
    if (stolen.value.outcome === 'gone') return acquireLock(scope, { runId, ttlMs }); // released between the looks: start again
    if (stolen.value.outcome === 'changed') return { acquired: false, holder: stolen.value.holder, reason: 'held' };
    audit(runId, 'lock.stolen', { scope, reason, ...(seen.holder && seen.holder.runId ? { previousRunId: String(seen.holder.runId) } : {}), ...(seen.holder && Number.isInteger(seen.holder.pid) ? { previousPid: seen.holder.pid } : {}) });
    return { acquired: true, release, lock: info, stole: reason };
  }
  function withLock(scope, opts, fn) {
    const got = acquireLock(scope, opts);
    if (!got.acquired) {
      const h = got.holder;
      throw Object.assign(codedError('LOCKED', `locked by ${h ? `run ${h.runId} since ${h.startedAt}` : 'another run'} (${scope})`), { holder: h || null });
    }
    try { return fn(got); } finally { got.release(); }
  }
  function listLocks() {
    let names;
    try { names = fs.readdirSync(p('locks')).filter((n) => n.endsWith('.lock')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return names.map((n) => {
      const seen = readLock(p('locks', n));
      return seen ? { file: n, ...(seen.holder || {}), unreadable: !seen.holder, stale: staleReason(seen) } : null;
    }).filter(Boolean);
  }

  // ---- overview and pruning ------------------------------------------------------------------------------------------------------
  function status() {
    const runs = listRuns();
    const keys = listKeys();
    const byState = {};
    for (const k of keys) byState[k.state] = (byState[k.state] || 0) + 1;
    const problem = versionProblem();
    return {
      dir: root,
      version: readVersion() === null ? null : Number(readVersion()) || readVersion(),
      warnings: problem ? [problem] : [],
      runs: { total: runs.length, finished: runs.filter((r) => r.finished).length, unfinished: runs.filter((r) => !r.finished).map((r) => r.runId || r.file) },
      keys: { total: keys.length, byState, inFlight: keys.filter((k) => k.state === 'claimed').map((k) => ({ key: k.key, runId: k.runId, claimedAt: k.claimedAt, ownerAlive: k.ownerAlive })) },
      locks: listLocks(),
    };
  }

  // Removes run files and key files older than the given ages (by modification time), plus leftover temp and tombstone files older than
  // a day. A key is only forgotten after keyDays, which must outlive the longest retry window a person could need.
  function prune({ runDays = 90, keyDays = 400, dryRun = false } = {}) {
    const removed = { runs: [], keys: [], leftovers: [] };
    const sweep = (sub, days, bucket, match) => {
      let names;
      try { names = fs.readdirSync(p(sub)); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      for (const n of names) {
        if (!match(n)) continue;
        const file = p(sub, n);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        if (now() - st.mtimeMs <= days * DAY_MS) continue;
        removed[bucket].push(n);
        if (!dryRun) fs.rmSync(file, { force: true });
      }
    };
    sweep('runs', runDays, 'runs', (n) => n.endsWith('.jsonl'));
    sweep('keys', keyDays, 'keys', (n) => n.endsWith('.json'));
    sweep('keys', 1, 'leftovers', (n) => /\.(tmp-.*|guard)$/.test(n));
    sweep('locks', 1, 'leftovers', (n) => /\.(tmp-.*|guard)$/.test(n));
    return { dryRun, ...removed };
  }

  return { dir: root, record, audit, readRun, readAudit, listRuns, claim, readClaim, complete, fail, listKeys, acquireLock, withLock, listLocks, status, prune, versionProblem };
}

module.exports = { openLedger, validateRecord, parseEvents, stemOf, pidAlive, TYPES, ENVELOPE, RESULT, VERSION, MAX_RECORD_BYTES, DEFAULT_LOCK_TTL_MS };

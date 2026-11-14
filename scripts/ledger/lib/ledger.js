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
//   * Reading never throws on a damaged ledger: a torn line, an unknown record type, a newer VERSION, a directory or a symlink where a file
//     should be, a file too big to be ours: each is a warning, or an "unreadable" entry, never an exception or a hang.
//   * Writing is narrow: every record, claim and lock is validated, secret-checked and size-capped; files are 0600 and the folders 0700.
//   * The ledger can only SUPPRESS (a key already done, a lock held) or RECORD. Nothing here ever grants permission to act.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { codedError } = require('../../lib/cli');
const { sanitize, runPart, isValidRunId } = require('../../lib/ids');
const { redactSecrets } = require('../../triage/lib/text');

const VERSION = 1;
const MAX_RECORD_BYTES = 8192;
const MAX_STRING = 200; // what an over-long string is cut to when a record has to be shrunk to fit
const MAX_KEY_LENGTH = 200;
const MAX_DEPTH = 20; // how deeply nested a value in a record may be (also what stops a circular one)
const MAX_RUN_FILE_BYTES = 16 * 1024 * 1024; // a run or audit file bigger than this is not read (it is not what this code wrote)
const MAX_SMALL_FILE_BYTES = 64 * 1024; // the same for a claim, a lock and VERSION
const DEFAULT_LOCK_TTL_MS = 2 * 60 * 60 * 1000;
const UNREADABLE_LOCK_GRACE_MS = 60 * 1000; // a lock file with nothing readable in it is a writer mid-write, until it has been that way this long
const DAY_MS = 24 * 60 * 60 * 1000;
const GUARD_STALE_MS = 60 * 1000; // a takeover guard older than this belongs to a process that died holding it
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0; // not on Windows; there it is simply absent

// Every record is { v, ts, runId, type, ...fields }. A field is 'string' | 'number' | 'boolean' | 'object' | 'array', or a list of the
// values it may have; a trailing '?' makes it optional. Fields not listed are refused, so the schema (schemas/ledger-record.schema.json,
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
const ENVELOPE = { v: [VERSION], ts: 'string', runId: 'string', type: Object.keys(TYPES), truncated: 'boolean?' };
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
  const envelope = checkFields({ v, ts, runId, type, truncated }, ENVELOPE, `${rec.type}`);
  if (envelope) return envelope;
  if (!ISO_TS.test(ts)) return `${rec.type}: "ts" must be an ISO 8601 UTC timestamp`;
  return checkFields(fields, known, `${rec.type}`);
}

// Everything that reaches a file passes through the same masking the triage report uses: a failure message can carry a token. Object keys
// too (a key can be a token), and a value nested deeper than MAX_DEPTH (or circular) is refused rather than followed.
function mask(value, depth = 0) {
  if (depth > MAX_DEPTH) throw codedError('LEDGER_INVALID', `a value is nested more than ${MAX_DEPTH} levels deep`);
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => mask(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (k !== '__proto__') out[redactSecrets(k)] = mask(v, depth + 1);
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

const sizeOf = (r) => Buffer.byteLength(JSON.stringify(r));

// One line, at most MAX_RECORD_BYTES. A record that is too big is shrunk, never dropped: long strings are cut first, then the biggest
// object and array fields are emptied, and the record says it was truncated.
function fitRecord(rec) {
  if (sizeOf(rec) <= MAX_RECORD_BYTES) return rec;
  let out = { ...shrinkStrings(rec), truncated: true };
  const bulky = Object.entries(out).filter(([, v]) => v && typeof v === 'object').sort((a, b) => sizeOf(b[1]) - sizeOf(a[1]));
  for (const [k, v] of bulky) {
    if (sizeOf(out) <= MAX_RECORD_BYTES) break;
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

// Names that end up inside a file are checked, not masked: masking would change the name, and a key or run id that no longer matches what the
// caller passed would silently stop deduplicating. A name that looks like a credential is refused (without echoing it).
const looksSecret = (s) => redactSecrets(s) !== s;
function assertRunId(runId) {
  if (!isValidRunId(runId)) throw codedError('LEDGER_INVALID', 'a run id is 1-128 printable characters');
  if (looksSecret(runId)) throw codedError('LEDGER_INVALID', 'a run id that looks like a credential is refused');
}
function assertKey(key) {
  if (typeof key !== 'string' || !key.length || key.length > MAX_KEY_LENGTH || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw codedError('LEDGER_INVALID', `a key is 1-${MAX_KEY_LENGTH} printable characters`);
  }
  if (looksSecret(key)) throw codedError('LEDGER_INVALID', 'a key that looks like a credential is refused');
}
function assertScope(scope) {
  if (typeof scope !== 'string' || !scope.length || scope.length > MAX_KEY_LENGTH || /[\u0000-\u001f\u007f]/u.test(scope)) {
    throw codedError('LEDGER_INVALID', `a lock scope is 1-${MAX_KEY_LENGTH} printable characters`);
  }
  if (looksSecret(scope)) throw codedError('LEDGER_INVALID', 'a lock scope that looks like a credential is refused');
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Reads a file without trusting what is at the path: never follows a symlink, never opens anything that is not a regular file (a FIFO would
// hang, a directory throws), and refuses a file bigger than maxBytes. { text, mtimeMs } | { missing: true } | { bad: why, mtimeMs? }.
function safeRead(file, maxBytes) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? { missing: true } : { bad: e.code || 'unreadable' }; }
  if (!st.isFile()) return { bad: st.isSymbolicLink() ? 'a symlink, not a file' : 'not a regular file', mtimeMs: st.mtimeMs };
  if (st.size > maxBytes) return { bad: `larger than ${maxBytes} bytes`, mtimeMs: st.mtimeMs };
  try { return { text: fs.readFileSync(file, 'utf8'), mtimeMs: st.mtimeMs }; } catch (e) { return e.code === 'ENOENT' ? { missing: true } : { bad: e.code || 'unreadable', mtimeMs: st.mtimeMs }; }
}
// The names in a folder; none when it is missing, is not a folder, or cannot be listed.
function listDir(dirPath) {
  try { return fs.readdirSync(dirPath); } catch { return []; }
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
    // a newer writer's record: a type this version does not have, or a layout version it does not write
    if (kindOf(rec) === 'object' && ((typeof rec.type === 'string' && !TYPES[rec.type]) || (Number.isInteger(rec.v) && rec.v !== VERSION))) { unknown += 1; return; }
    const bad = validateRecord(rec);
    if (bad) { warnings.push(`${label}: line ${i + 1} skipped (${bad})`); return; }
    events.push(rec);
  });
  if (unknown) warnings.push(`${label}: ${unknown} record${unknown === 1 ? '' : 's'} this version does not understand (an unknown type, or written by a newer version), skipped`);
  return { events, warnings };
}

function openLedger({ dir, now = Date.now, pid = process.pid, host = os.hostname() } = {}) {
  if (!dir) throw codedError('LEDGER_INVALID', 'a ledger needs a directory');
  const root = path.resolve(dir);
  const p = (...parts) => path.join(root, ...parts);
  const iso = () => new Date(now()).toISOString();
  let ready = false;

  // null when there is no VERSION yet (or it is empty: a writer cut off between creating it and filling it, which init repairs);
  // '?' when it is there but is not a readable file.
  const readVersion = () => {
    const r = safeRead(p('VERSION'), 64);
    if (r.missing) return null;
    if (r.bad) return '?';
    return r.text.trim() || null;
  };
  // null when this code may read and write the ledger; otherwise why not (a newer layout than this code understands)
  const versionProblem = () => {
    const found = readVersion();
    if (found === null || found === String(VERSION)) return null;
    return found === '?' ? 'the ledger VERSION file is not a readable file: reading only'
      : `ledger layout version ${JSON.stringify(found.slice(0, 20))} is not one this code understands (it writes ${VERSION}): reading only`;
  };

  // VERSION is created complete or not at all: written to a temp file and hard-linked into place (link fails if the name exists), so a
  // second first-time writer never sees it empty. An EMPTY VERSION left by a writer that died mid-create is replaced.
  function writeVersion() {
    const target = p('VERSION');
    const tmp = `${target}.tmp-${pid}-${sha(`${now()}${Math.random()}`, 8)}`;
    fs.writeFileSync(tmp, `${VERSION}\n`, { mode: 0o600 });
    try {
      try { fs.linkSync(tmp, target); } catch (e) {
        if (e.code === 'EEXIST') { if (readVersion() === null) fs.renameSync(tmp, target); } // empty: repair it
        else if (['EPERM', 'ENOTSUP', 'EXDEV', 'EMLINK', 'ENOSYS'].includes(e.code)) { // a filesystem without hard links: create it the plain way
          try { fs.writeFileSync(target, `${VERSION}\n`, { flag: 'wx', mode: 0o600 }); } catch (e2) { if (e2.code !== 'EEXIST') throw e2; }
        } else throw e;
      }
    } finally { fs.rmSync(tmp, { force: true }); }
  }

  // The first write creates the folders (0700) and the VERSION file; a newer VERSION makes every write refuse.
  function init() {
    if (ready) return;
    for (const sub of ['', 'runs', 'keys', 'locks']) fs.mkdirSync(p(sub), { recursive: true, mode: 0o700 });
    if (readVersion() === null) writeVersion();
    const problem = versionProblem();
    if (problem) throw codedError('LEDGER_VERSION', problem);
    ready = true;
  }

  const build = (runId, type, fields) => {
    assertRunId(runId);
    for (const k of Object.keys(ENVELOPE)) if (Object.hasOwn(fields, k)) throw codedError('LEDGER_INVALID', `${type}: "${k}" belongs to the record envelope, not its fields`);
    let rec;
    try { rec = fitRecord({ v: VERSION, ts: iso(), runId, type, ...mask(fields) }); } catch (e) {
      if (e.code) throw e;
      throw codedError('LEDGER_INVALID', `${type}: a field cannot be written as JSON (${e.message})`);
    }
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
        try { st = fs.lstatSync(guard); } catch (e2) { if (e2.code === 'ENOENT') continue; throw e2; }
        if (now() - st.mtimeMs > GUARD_STALE_MS) { fs.rmSync(guard, { force: true }); continue; }
        return { guarded: false };
      }
      try { return { guarded: true, value: fn() }; } finally { fs.rmSync(guard, { force: true }); }
    }
    return { guarded: false };
  }
  // Appends one line. Never through a symlink (O_NOFOLLOW), and never glued onto a line that was cut off: when the file does not end in a
  // newline (a write died half-way), a newline goes first, so the new record is a line of its own and only the cut-off one is lost.
  const append = (file, rec) => {
    const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW, 0o600);
    try {
      const { size } = fs.fstatSync(fd);
      let lead = '';
      if (size > 0) { const last = Buffer.alloc(1); fs.readSync(fd, last, 0, 1, size - 1); if (last[0] !== 0x0a) lead = '\n'; }
      fs.writeSync(fd, `${lead}${JSON.stringify(rec)}\n`);
    } finally { fs.closeSync(fd); }
  };

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
    const r = safeRead(file, MAX_RUN_FILE_BYTES);
    if (r.missing) return { events: [], warnings: [] };
    if (r.bad) return { events: [], warnings: [`${label}: not read (${r.bad})`] };
    return parseEvents(r.text, label);
  };
  function readRun(runId) {
    const { events, warnings } = readFile(p('runs', `${stemOf(runId)}.jsonl`), `run ${String(runId).slice(0, 60)}`);
    const mine = events.filter((e) => e.runId === runId); // a stem shared by two ids would be a bug in stemOf; never mix their events
    const problem = versionProblem();
    return { runId, events: mine, warnings: problem ? [problem, ...warnings] : warnings, finished: mine.some((e) => e.type === 'run.end') };
  }
  const readAudit = () => {
    const { events, warnings } = readFile(p('audit.jsonl'), 'audit');
    const problem = versionProblem();
    return { events, warnings: problem ? [problem, ...warnings] : warnings };
  };

  function listRuns() {
    return listDir(p('runs')).filter((n) => n.endsWith('.jsonl')).sort().map((n) => {
      const { events, warnings } = readFile(p('runs', n), n);
      const first = events[0];
      const end = events.find((e) => e.type === 'run.end');
      return { runId: first ? first.runId : null, file: n, events: events.length, startedAt: first ? first.ts : null, finished: Boolean(end), endedAt: end ? end.ts : null, complete: end ? end.complete : null, ...(first ? {} : { unreadable: warnings[0] || 'empty' }) };
    });
  }

  // ---- idempotency keys ----------------------------------------------------------------------------------------------------------
  const keyPath = (key) => p('keys', `${sha(key, 32)}.json`);
  // The claim for a key: its record when readable; { state: 'claimed', unreadable: true } when the file exists but cannot be used (empty, torn,
  // a directory, a symlink: a writer is mid-write or died there, and the key IS taken); null when nobody has claimed it.
  function readClaim(key) {
    assertKey(key);
    const r = safeRead(keyPath(key), MAX_SMALL_FILE_BYTES);
    if (r.missing) return null;
    const unreadable = { key, state: 'claimed', unreadable: true };
    if (r.bad) return unreadable;
    let rec;
    try { rec = JSON.parse(r.text); } catch { return unreadable; }
    if (kindOf(rec) !== 'object' || typeof rec.key !== 'string') return unreadable;
    if (rec.key !== key) throw codedError('LEDGER_KEY_COLLISION', `the claim file for this key holds a different key (${JSON.stringify(rec.key.slice(0, 60))})`);
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
  // A `failed` claim may be taken over by exactly one caller (see withGuard).
  function claim(key, { runId } = {}, attempt = 0) {
    init();
    assertKey(key);
    if (runId !== undefined && runId !== null) assertRunId(runId);
    const mine = { v: VERSION, key, runId: runId || null, state: 'claimed', claimedAt: iso(), pid, host };
    if (tryCreateClaim(key, mine)) return { won: true, claim: mine };
    let cur = readClaim(key);
    if (cur && cur.state === 'failed') {
      // Only one caller at a time may replace a failed claim, and only if it is still the failed claim we looked at: another caller may have
      // taken it over (and written a fresh claim, or failed again) since.
      const r = withGuard(keyPath(key), () => {
        const again = readClaim(key);
        if (!again || again.state !== 'failed' || again.completedAt !== cur.completedAt) return false;
        writeClaimAtomically(key, { ...mine, previousFailure: cur.error || null });
        return true;
      });
      if (r.guarded && r.value) return { won: true, claim: mine, tookOverFailed: true };
      cur = readClaim(key);
    }
    if (!cur) { // it vanished between the two looks (pruned or taken over): look again, a few times
      if (attempt >= 3) throw codedError('LEDGER_IO', 'the claim file for this key keeps appearing and disappearing');
      return claim(key, { runId }, attempt + 1);
    }
    return { won: false, state: cur.state === 'done' ? 'done' : 'in-flight', claim: cur, ownerAlive: cur.state === 'done' ? null : ownerAlive(cur) };
  }

  function finish(key, state, extra) {
    init();
    assertKey(key);
    const cur = readClaim(key);
    if (!cur) throw codedError('LEDGER_NO_CLAIM', 'no claim for this key: claim it first');
    if (cur.state === 'done') return { changed: false, claim: cur };
    if (cur.state === 'failed') {
      if (state === 'failed') return { changed: false, claim: cur };
      throw codedError('LEDGER_CLAIM_FAILED', 'this claim failed: claim the key again before completing it'); // a failed claim may already be someone else's to take over
    }
    const next = { ...(cur.unreadable ? { v: VERSION, key } : cur), state, completedAt: iso(), ...extra };
    writeClaimAtomically(key, next);
    return { changed: true, claim: next };
  }
  function complete(key, result = {}) {
    const bad = checkFields(result, RESULT, 'result');
    if (bad) throw codedError('LEDGER_INVALID', bad);
    const masked = mask(result);
    return finish(key, 'done', { result: sizeOf(masked) > MAX_RECORD_BYTES ? shrinkStrings(masked) : masked });
  }
  function fail(key, { code, message } = {}) {
    if (typeof code !== 'string' || !code) throw codedError('LEDGER_INVALID', 'a failure needs a code');
    const error = { code: String(mask(code)).slice(0, 80), ...(message === undefined ? {} : { message: String(mask(String(message))).slice(0, 300) }) };
    return finish(key, 'failed', { error });
  }
  function listKeys() {
    return listDir(p('keys')).filter((n) => n.endsWith('.json')).map((n) => {
      const r = safeRead(p('keys', n), MAX_SMALL_FILE_BYTES);
      let rec = null;
      if (r.text !== undefined) { try { rec = JSON.parse(r.text); } catch { rec = null; } }
      if (kindOf(rec) !== 'object' || typeof rec.key !== 'string') return { file: n, key: null, state: 'claimed', unreadable: true };
      return { file: n, key: rec.key, runId: rec.runId, state: rec.state, claimedAt: rec.claimedAt, completedAt: rec.completedAt, ownerAlive: rec.state === 'claimed' ? ownerAlive(rec) : null };
    });
  }

  // ---- locks ---------------------------------------------------------------------------------------------------------------------
  const lockPath = (scope) => p('locks', `${sha(scope, 32)}.lock`);
  // { holder } when the lock file says who holds it; { holder: null, mtime } when it exists but says nothing usable (empty, torn, a
  // directory, a symlink); null when there is no lock.
  function readLock(file) {
    const r = safeRead(file, MAX_SMALL_FILE_BYTES);
    if (r.missing) return null;
    const mtime = r.mtimeMs === undefined ? now() : r.mtimeMs;
    if (r.bad) return { holder: null, mtime };
    let rec;
    try { rec = JSON.parse(r.text); } catch { return { holder: null, mtime }; }
    return kindOf(rec) === 'object' ? { holder: rec, mtime } : { holder: null, mtime };
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
  function acquireLock(scope, { runId, ttlMs = DEFAULT_LOCK_TTL_MS } = {}, attempt = 0) {
    init();
    assertScope(scope);
    assertRunId(runId);
    if (!(typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0)) throw codedError('LEDGER_INVALID', 'a lock TTL is a positive number of milliseconds');
    const retry = () => {
      if (attempt >= 3) throw codedError('LEDGER_IO', 'the lock file for this scope keeps appearing and disappearing');
      return acquireLock(scope, { runId, ttlMs }, attempt + 1);
    };
    const file = lockPath(scope);
    const info = { v: VERSION, scope, runId, pid, host, startedAt: iso(), ttlMs };
    const release = () => {
      const seen = readLock(file);
      if (seen && sameHolder(seen.holder, info)) fs.rmSync(file, { force: true }); // only our own: after a steal the file is someone else's
    };
    if (createLock(file, info)) return { acquired: true, release, lock: info };
    const seen = readLock(file);
    if (!seen) return retry(); // released between the two looks
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
    if (stolen.value.outcome === 'gone') return retry(); // released between the looks: start again
    if (stolen.value.outcome === 'changed') return { acquired: false, holder: stolen.value.holder, reason: 'held' };
    audit(runId, 'lock.stolen', { scope, reason, ...(seen.holder && seen.holder.runId ? { previousRunId: String(seen.holder.runId) } : {}), ...(seen.holder && Number.isInteger(seen.holder.pid) ? { previousPid: seen.holder.pid } : {}) });
    return { acquired: true, release, lock: info, stole: reason };
  }
  function withLock(scope, opts, fn) {
    const got = acquireLock(scope, opts);
    if (!got.acquired) {
      const h = got.holder;
      throw Object.assign(codedError('LOCKED', `locked by ${h ? `run ${String(h.runId).slice(0, 60)} since ${String(h.startedAt).slice(0, 40)}` : 'another run'} (${scope})`), { holder: h || null });
    }
    try { return fn(got); } finally { got.release(); }
  }
  function listLocks() {
    return listDir(p('locks')).filter((n) => n.endsWith('.lock')).map((n) => {
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
    const version = readVersion();
    return {
      dir: root,
      version: version === null ? null : Number(version) || version,
      warnings: problem ? [problem] : [],
      runs: { total: runs.length, finished: runs.filter((r) => r.finished).length, unfinished: runs.filter((r) => !r.finished).map((r) => r.runId || r.file) },
      keys: { total: keys.length, byState, inFlight: keys.filter((k) => k.state === 'claimed').map((k) => ({ key: k.key, runId: k.runId, claimedAt: k.claimedAt, ownerAlive: k.ownerAlive })) },
      locks: listLocks(),
    };
  }

  // Removes run files and key files older than the given ages (by modification time), plus leftover temp and guard files older than a day.
  // A key is only forgotten after keyDays, which must outlive the longest retry window a person could need. Like every write it refuses a
  // ledger of a newer layout, and an entry it cannot remove (a directory, say) is reported in `errors`, not thrown.
  function prune({ runDays = 90, keyDays = 400, dryRun = false } = {}) {
    for (const [what, v] of [['runDays', runDays], ['keyDays', keyDays]]) {
      if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) throw codedError('LEDGER_INVALID', `${what} must be a positive number`);
    }
    const problem = versionProblem();
    if (problem) throw codedError('LEDGER_VERSION', problem);
    const removed = { runs: [], keys: [], leftovers: [], errors: [] };
    const sweep = (sub, days, bucket, match) => {
      for (const n of listDir(p(sub))) {
        if (!match(n)) continue;
        const file = p(sub, n);
        let st;
        try { st = fs.lstatSync(file); } catch { continue; }
        if (now() - st.mtimeMs <= days * DAY_MS) continue;
        removed[bucket].push(n);
        if (dryRun) continue;
        try { fs.rmSync(file, { force: true }); } catch (e) { removed.errors.push(`${n}: ${e.code || 'cannot be removed'}`); }
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

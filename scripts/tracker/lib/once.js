'use strict';

// A tracker write that happens ONCE, however many times it is attempted (a retry, a re-run, a crash and a resume): the run ledger's claim protocol around
// the adapter's own idempotency (docs/phase-3-design.md, "Idempotency and resume"). The adapter already looks for an item carrying the key's marker before it
// creates one; the ledger adds what the marker cannot give:
//
//   * a key the ledger knows is DONE is skipped without touching the tracker (and says so: `fromLedger`);
//   * a key CLAIMED by a process that is writing right now is not written a second time (IN_PROGRESS, retry later);
//   * a key claimed by a process that is GONE (or on another machine, or that has held it far longer than a write can take) is resumed: the claim is marked
//     failed and taken over, and the adapter's marker lookup then finds whatever the dead run managed to create (a claim proves intent, not effect);
//   * what was written, and what failed, is on record (the audit log), not only in a keys file next to one command's output.
//
// The ledger never makes a write MORE likely: without one (or when it cannot be written to) this is exactly `run`, and the adapter's marker dedupe is
// what is left. Only create-style operations with an idempotency key are touched.
//
// Taking a claim over is compare-and-set: `fail` and `complete` say WHICH claim they mean (`expect`), and do nothing if the key now holds another one, so
// two resumers that looked at the same dead claim cannot both end up writing, and a slow writer that was already replaced cannot overwrite its replacement.
const { run } = require('../adapters');
const { validate } = require('./contract');
const { TrackerError } = require('./errors');

const LEDGERED = new Set(['create-test', 'create-bug', 'comment']);
// No write takes this long (an HTTP request times out in seconds): a claim held for longer than this by a process that merely LOOKS alive (a reused process
// id, a hung writer, a container whose name never changes) is treated as abandoned.
const CLAIM_STALE_MS = 15 * 60 * 1000;
const active = new Set(); // the ledger keys THIS process is writing right now

// The key the ledger holds a write under: the tracker (its kind AND where it points: the repository, project or list the settings name), the operation and
// the key. One ticket id on two trackers, the same project after its repository setting was changed, or a bug and a comment that share a key are not the same write.
const ledgerKey = (adapter, op, key) => `${adapter.source}${adapter.target ? `~${adapter.target}` : ''}/${op}/${key}`;

const resultOf = (data) => ({
  ...(data.id !== undefined && data.id !== null ? { id: String(data.id) } : {}),
  ...(typeof data.url === 'string' ? { url: data.url } : {}),
  ...(typeof data.deduplicated === 'boolean' ? { deduplicated: data.deduplicated } : {}),
});

async function runOnce(adapter, op, rawInput, { ledger, runId, warn = () => {}, now = Date.now } = {}) {
  const input = validate(op, rawInput); // a bad input or key is refused before anything is claimed
  if (!ledger || !LEDGERED.has(op) || !input.idempotencyKey) return run(adapter, op, rawInput);

  const key = ledgerKey(adapter, op, input.idempotencyKey);
  const host = ledger.host; // who this process is, as the ledger knows it (the ledger tells apart a claim of its own host)
  const safe = (fn, fallback) => { try { return fn(); } catch (e) { warn(`ledger: ${e.message}`); return fallback; } };
  const audit = (type, fields) => safe(() => ledger.audit(runId || 'unattributed', type, fields));
  const target = op === 'comment' ? input.id : op === 'create-test' ? input.parentId : undefined;
  const fromLedger = (claim) => ({ ...(claim.result || {}), deduplicated: true, fromLedger: true });
  const ageMs = (claim) => { const t = Date.parse(claim.claimedAt); return Number.isFinite(t) ? now() - t : Infinity; };
  // Is the claim's owner writing right now? A process that is alive and whose claim is not older than a write can take; and, when it is THIS process, only
  // if it really is in the middle of that write (a claim this process left behind, say because it could not record the completion, is nobody's work).
  const stillWriting = (c) => c.ownerAlive === true && ageMs(c.claim) <= CLAIM_STALE_MS && !(c.claim.pid === process.pid && c.claim.host === host && !active.has(key));
  const busy = (claim) => {
    const minutes = Math.max(0, Math.round(ageMs(claim) / 60000));
    return new TrackerError('IN_PROGRESS', `${op} ${input.idempotencyKey} is being written right now by run ${claim.runId || '(no run id)'} (process ${claim.pid}, claimed ${Number.isFinite(minutes) ? `${minutes} minute(s) ago` : 'at an unknown time'}); look again when it has finished. If that run is gone: node scripts/ledger/cli.js forget --key "${key}" --force`,
      { details: { key, runId: claim.runId || null, pid: claim.pid, claimedAt: claim.claimedAt } });
  };

  let c = safe(() => ledger.claim(key, { runId }), null);
  if (!c) return run(adapter, op, rawInput); // the ledger cannot be used: the adapter's own marker still dedupes
  let resumed = false;
  if (!c.won) {
    if (c.state === 'done') return fromLedger(c.claim);
    if (stillWriting(c)) throw busy(c.claim);
    // Its owner is gone, or cannot be checked (another machine), or has held it too long. Resume: mark THAT claim failed (compare-and-set: if the key now holds
    // somebody else's claim this does nothing), then claim it. Exactly one resumer wins; the others find a live claim, or a finished one.
    safe(() => ledger.fail(key, { code: 'OWNER_GONE', message: `claimed by run ${c.claim.runId || '(none)'}, process ${c.claim.pid} on ${c.claim.host}, which did not finish it` }, { expect: c.claim }));
    c = safe(() => ledger.claim(key, { runId }), null);
    if (!c) return run(adapter, op, rawInput);
    if (!c.won) { if (c.state === 'done') return fromLedger(c.claim); throw busy(c.claim); } // someone else resumed it first
    resumed = true;
  }
  const mine = c.claim;
  audit('action.claimed', { key, step: op, ...(target ? { target: String(target) } : {}) });
  active.add(key);
  try {
    const data = await run(adapter, op, rawInput); // the adapter looks for the key's marker first: after a crash this is what adopts what was already created
    const result = resultOf(data);
    const done = safe(() => ledger.complete(key, result, { expect: mine }), null);
    if (done && (done.mismatch || done.busy)) warn(`ledger: the claim on ${key} was taken over before its completion could be recorded; the item exists, and whoever holds the key adopts it`);
    audit('action.done', { key, ...result });
    return resumed ? { ...data, resumed: true } : data;
  } catch (err) {
    const code = err instanceof TrackerError ? err.code : 'UNEXPECTED';
    safe(() => ledger.fail(key, { code, message: err && err.message ? err.message : String(err) }, { expect: mine }));
    audit('action.failed', { key, code, message: err && err.message ? err.message : String(err) });
    throw err;
  } finally {
    active.delete(key);
  }
}

module.exports = { runOnce, ledgerKey, LEDGERED, CLAIM_STALE_MS };

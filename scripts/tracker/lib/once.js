'use strict';

// A tracker write that happens ONCE, however many times it is attempted (a retry, a re-run, a crash and a resume): the run ledger's claim protocol around
// the adapter's own idempotency (docs/phase-3-design.md, "Idempotency and resume"). The adapter already looks for an item carrying the key's marker before it
// creates one; the ledger adds what the marker cannot give:
//
//   * a key the ledger knows is DONE is skipped without touching the tracker (and says so: `fromLedger`);
//   * a key CLAIMED by a process that is running right now is not written a second time (IN_PROGRESS, retry later);
//   * a key claimed by a process that is GONE (or on another machine) is resumed: the claim is marked failed and taken over, and the adapter's marker
//     lookup then finds whatever the dead run managed to create (the adapter's lookup is the reconcile step; a claim proves intent, not effect);
//   * what was written, and what failed, is on record (the audit log), not only in a keys file next to one command's output.
//
// The ledger never makes a write MORE likely: without one (or when it cannot be written to) this is exactly `run`, and the adapter's marker dedupe is
// what is left. Only create-style operations with an idempotency key are touched.
const { run } = require('../adapters');
const { validate } = require('./contract');
const { TrackerError } = require('./errors');

const LEDGERED = new Set(['create-test', 'create-bug', 'comment']);
// The key the ledger holds a write under: the tracker and the operation are part of it, so one ticket id on two trackers (or a bug and a comment that
// happen to share a key) are not the same write.
const ledgerKey = (adapter, op, key) => `${adapter.source}/${op}/${key}`;

const resultOf = (data) => ({
  ...(data.id !== undefined && data.id !== null ? { id: String(data.id) } : {}),
  ...(typeof data.url === 'string' ? { url: data.url } : {}),
  ...(typeof data.deduplicated === 'boolean' ? { deduplicated: data.deduplicated } : {}),
});

async function runOnce(adapter, op, rawInput, { ledger, runId, warn = () => {} } = {}) {
  const input = validate(op, rawInput); // a bad input or key is refused before anything is claimed
  if (!ledger || !LEDGERED.has(op) || !input.idempotencyKey) return run(adapter, op, rawInput);

  const key = ledgerKey(adapter, op, input.idempotencyKey);
  const safe = (fn, fallback) => { try { return fn(); } catch (e) { warn(`ledger: ${e.message}`); return fallback; } };
  const audit = (type, fields) => safe(() => ledger.audit(runId || 'unattributed', type, fields));
  const target = op === 'comment' ? input.id : op === 'create-test' ? input.parentId : undefined;
  const fromLedger = (claim) => ({ ...(claim.result || {}), deduplicated: true, fromLedger: true });
  const busy = (claim) => new TrackerError('IN_PROGRESS', `${op} ${input.idempotencyKey} is being written right now by run ${claim.runId || '(no run id)'} (process ${claim.pid}); look again when it has finished`,
    { details: { key, runId: claim.runId || null, pid: claim.pid, claimedAt: claim.claimedAt } });

  let c = safe(() => ledger.claim(key, { runId }), null);
  if (!c) return run(adapter, op, rawInput); // the ledger cannot be used: the adapter's own marker still dedupes
  let resumed = false;
  if (!c.won) {
    if (c.state === 'done') return fromLedger(c.claim);
    if (c.ownerAlive === true) throw busy(c.claim);
    // Its owner is gone (or is on another machine and cannot be checked): resume. The claim is marked failed so that exactly one resumer takes it over.
    safe(() => ledger.fail(key, { code: 'OWNER_GONE', message: `claimed by run ${c.claim.runId || '(none)'}, process ${c.claim.pid} on ${c.claim.host}, which did not finish it` }));
    c = safe(() => ledger.claim(key, { runId }), null);
    if (!c) return run(adapter, op, rawInput);
    if (!c.won) { if (c.state === 'done') return fromLedger(c.claim); throw busy(c.claim); } // someone else resumed it first
    resumed = true;
  }
  audit('action.claimed', { key, step: op, ...(target ? { target: String(target) } : {}) });
  try {
    const data = await run(adapter, op, rawInput); // the adapter looks for the key's marker first: after a crash this is what adopts what was already created
    const result = resultOf(data);
    safe(() => ledger.complete(key, result));
    audit('action.done', { key, ...result });
    return resumed ? { ...data, resumed: true } : data;
  } catch (err) {
    const code = err instanceof TrackerError ? err.code : 'UNEXPECTED';
    safe(() => ledger.fail(key, { code, message: err && err.message ? err.message : String(err) }));
    audit('action.failed', { key, code, message: err && err.message ? err.message : String(err) });
    throw err;
  }
}

module.exports = { runOnce, ledgerKey, LEDGERED };

'use strict';

// What self-heal needs from the ledger, as one small object so heal.js does not depend on the ledger's layout: the number of attempts already
// made for a failure, and a place to say that a heal began and how it ended. Bookkeeping must never change what a heal does: a ledger that
// cannot be written to is a warning (passed to `warn`), not a failed heal, and not a skipped revert.
const { healAttempts, DAY_MS } = require('./views');

function healJournal({ ledger, runId, maxAttempts, windowDays, now = Date.now, warn = () => {} }) {
  const safe = (fn, fallback) => { try { return fn(); } catch (e) { warn(`ledger: ${e.message}`); return fallback; } };
  return {
    maxAttempts,
    windowDays,
    // { token: n } for the given tokens. If the ledger cannot be read the counts are zero and the cap does not hold: it is a guard against a
    // loop, not a security boundary (the ledger is a plain file; see docs/phase-3-design.md "The ledger never grants permission").
    attempts: (tokens) => safe(() => healAttempts(ledger, { sinceMs: now() - windowDays * DAY_MS, tokens }), {}),
    begin: (fields) => safe(() => ledger.record(runId, 'heal.begin', fields)),
    end: (fields) => safe(() => ledger.record(runId, 'heal.end', fields)),
  };
}

module.exports = { healJournal };

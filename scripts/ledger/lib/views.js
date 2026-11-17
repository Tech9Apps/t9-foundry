'use strict';

// Questions that need many runs at once, answered from the events (never from extra state, so they cannot drift from the log): how often a
// test flips, how many times a heal has been tried for a failure, and which heal began and never said how it ended.
// All of them read through ledger.readAllRuns({ types }), which streams the files, keeps only the record types asked for and never throws on a
// damaged ledger. A run is one run.start to its run.end, even when a run id was used twice and both runs share a file.

const DAY_MS = 24 * 60 * 60 * 1000;
const testKey = (r) => `${r.spec}\u0000${r.name}`;

// Self-heal attempts that began and never ended: the run died (SIGKILL, a crash, a power cut) while its branch existed, so `qa/heal-*` may still be there.
function staleHeals(ledger) {
  const out = [];
  for (const run of ledger.readAllRuns({ types: ['heal.begin', 'heal.end'] })) {
    for (const b of run.events.filter((e) => e.type === 'heal.begin')) {
      const ended = run.events.some((e) => e.type === 'heal.end' && e.branch === b.branch && e.ts >= b.ts);
      if (!ended) out.push({ runId: run.runId, branch: b.branch, baseSha: b.baseSha, since: b.ts, tokens: b.tokens || [] });
    }
  }
  return out;
}

// { token: n }: how many heals began since `sinceMs` for each failure token. One heal is one attempt, however many times its record names a token.
// A heal that began and never ended counts (a crash used the attempt).
function healAttempts(ledger, { sinceMs, tokens }) {
  const counts = Object.fromEntries(tokens.map((t) => [t, 0]));
  for (const run of ledger.readAllRuns({ types: ['heal.begin'] })) {
    for (const e of run.events) {
      if (e.type !== 'heal.begin' || !(Date.parse(e.ts) >= sinceMs)) continue;
      for (const t of new Set(e.tokens || [])) if (Object.hasOwn(counts, t)) counts[t] += 1;
    }
  }
  return counts;
}

// How often each test flipped within a run, over its last `window` COMPLETED runs. A flip is a pass and a fail of the same test in DIFFERENT phases of
// one run (the main run against a re-run), or the runner's own "flaky" mark (it passed after retries). Two tests that merely share a title in one file
// and disagree in the same phase are not a flip. A run that did not complete says nothing reliable (its re-runs may never have happened), so it is not
// counted. Report-only: quarantine is Phase 5.
function flakeRates(ledger, { window = 20, includeStable = false } = {}) {
  const runs = ledger.readAllRuns({ types: ['test.result'] }).filter((r) => r.complete);
  const perTest = new Map();
  for (const run of runs) {
    const seen = new Map();
    for (const e of run.events) {
      if (e.type !== 'test.result' || e.status === 'skipped') continue;
      const k = testKey(e);
      if (!seen.has(k)) seen.set(k, { spec: e.spec, name: e.name, passedIn: new Set(), failedIn: new Set(), marked: false });
      const t = seen.get(k);
      (e.status === 'passed' ? t.passedIn : t.failedIn).add(e.phase);
      if (e.flaky) t.marked = true;
    }
    for (const [k, t] of seen) {
      if (!perTest.has(k)) perTest.set(k, { spec: t.spec, name: t.name, history: [] });
      const flipped = t.marked || [...t.passedIn].some((p) => [...t.failedIn].some((q) => q !== p));
      perTest.get(k).history.push({ runId: run.runId, at: run.startedAt, flipped });
    }
  }
  const tests = [...perTest.values()].map((t) => {
    const last = t.history.slice(-window);
    const flips = last.filter((h) => h.flipped);
    return { spec: t.spec, name: t.name, runsSeen: last.length, flips: flips.length, rate: flips.length / last.length, lastFlipAt: flips.length ? flips[flips.length - 1].at : null };
  }).filter((t) => includeStable || t.flips > 0)
    .sort((a, b) => b.rate - a.rate || b.flips - a.flips || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { window, runsConsidered: runs.length, tests };
}

module.exports = { staleHeals, healAttempts, flakeRates, DAY_MS };

# Phase 3 design: state, idempotency, observability

Status: **planned, not built.** This document is the plan, written and reviewed *before* the code, so that anyone can see what was
intended and compare it with what shipped. When the build changes the design, a "What the build changed" section is added at the
bottom (as in [phase-2-design.md](./phase-2-design.md)); the plan above it is not rewritten.

Parent plan: [v2-plan.md](./v2-plan.md), "Phase 3". Phases 0–2 are on `main`.

## Decisions already made

| # | Decision | Answer |
|---|---|---|
| 1 | Ledger format | **JSONL.** No dependency, diffable, append-only fits an audit log. SQLite stays a later option if trend queries outgrow it (see "Limits"). |
| 2 | Verification | **Mocks only.** No real tracker, no live model. Everything below is verified against in-process `fetch` mocks and real child processes (kill, signal, concurrency). `scripts/tracker/smoke.js` remains the tool for whoever has a token. |
| 3 | How v2 is documented | **One design doc per phase, merged to `main` before the phase's code.** The code PR links the doc; the doc gets a "What the build changed" section. Phases 4 and 5 follow the same path. |

## Proposed defaults (open until this PR is reviewed)

These are my recommendations, not decisions. Say so in review and they change.

- **Where the ledger lives:** `.qa-ledger/` in the project, **gitignored**, location overridable with `ledger.dir` in `qa-config.json`.
  CI persists it between runs with a cache or artifact (the Phase 4 templates do this). It is not committed: it holds per-run
  detail that churns, and a committed audit log invites hand edits that look legitimate in a diff.
- **Retention:** 90 days of run files, then `ledger prune`. Idempotency keys are kept 400 days (a key must outlive the longest plausible
  retry window and the tracker's own history).
- **Slack:** off unless `QA_SLACK_WEBHOOK` is set, and then only to `hooks.slack.com` unless the config names another host.

## What this phase is for

Phase 2 closed the loop but each run is an island. The limits it documented are all "needs a ledger":

| Phase 2 limit | What closes it here |
|---|---|
| No cross-run flake rate; flaky is judged within one run's re-runs | per-test history, computed from `test.result` events |
| "One attempt per failing test per run"; no cross-run cap on heal attempts | a per-fingerprint attempt count in the ledger, with a cap |
| A bug filed seconds ago may not show in tracker search (index lag) | the ledger remembers "fingerprint X → bug Y, filed at T" and the planner consults it before search |
| `qa/heal-*` branches left behind by a crash or SIGKILL (S4) | the run's events say a heal began and did not finish, so the next run (or `ledger status`) can name the stale branch |
| `post-tests` resumes from a keys file that is itself a hand-rolled ledger | keys move to the ledger; the keys file stays as a read-only compatibility path |
| Nothing stops two runs hitting one environment or one ticket | locks and a per-ticket cooldown |
| A run's outcome lives in scattered files | one markdown summary per run |

Not in this phase: autonomy tiers, the PreToolUse enforcement hook, the kill switch, `run-autonomous.sh`, CI templates (all Phase 4);
quarantine and exploratory testing (Phase 5). Where Phase 3 defines a setting that Phase 4 enforces (turn and cost budgets), this
document says so.

## The ledger

### Layout

```
.qa-ledger/
  VERSION                     schema version of the files below ("1")
  runs/<runId>.jsonl          events of ONE run, appended by that run only
  keys/<hash>.json            one idempotency claim per file, created with O_EXCL
  locks/<scope>.lock          lock files (see "Locks")
  audit.jsonl                 every external write or proposal, all runs, append-only
```

Why not one big `events.jsonl`: two runs would interleave appends into one file, and "one writer per file" is the property that makes a
torn line impossible to confuse with someone else's data. Per-run files give that for free; the lock (below) guarantees one run per
`runId`. Cross-run questions (flake rate, attempt count) scan `runs/` — fine at the scale this tool runs at (tens of runs a day,
tens of KB each), and the reason SQLite stays a *later* option rather than a now option.

Why keys are separate files: **`O_EXCL` file creation is the one atomic compare-and-set a filesystem gives you.** Claiming a key is
`open(path, 'wx')`; if it throws `EEXIST` the key is taken. No lock, no read-modify-write race, and two processes claiming the same key
get exactly one winner.

### Records

Every line is one JSON object with a common envelope: `{ "v": 1, "ts": "<ISO 8601>", "runId": "...", "type": "...", ... }`. Types:

| type | written by | payload |
|---|---|---|
| `run.start` | orchestrate | framework, source, config sources (flag / config / default), pid, host, ticket (if any) |
| `test.result` | orchestrate (from the normalized run result) | spec, test name, status, phase (`main` / `rerun-k`), duration |
| `verdict` | orchestrate (from the triage report) | fingerprint token, class, confidence, action, step |
| `action.claimed` | plan consumers | idempotency key, step, target (ticket / fingerprint) |
| `action.done` | whoever performed it | key, result id and url, `deduplicated` flag |
| `action.failed` | same | key, error code (never the raw message; see "Secrets") |
| `heal.begin` / `heal.end` | heal | branch, base sha, outcome (`kept`, `reverted`, `interrupted`) |
| `budget` | run end | wall-clock ms, turns and cost if the caller supplied them |
| `run.end` | orchestrate | exit status, counts, `complete: true` |

`run.end` is how a reader tells a finished run from a crashed one: **no `run.end` means the run did not finish**, whatever else is in
the file. The schema is `schemas/ledger-record.schema.json` (a `oneOf` over the types), validated in tests and by the reader.

### Reading is defensive

- A **torn final line** (a crash mid-write) is skipped with a warning, never an error. A torn line in the *middle* is a warning and is
  skipped too; the rest of the file is still used.
- A record with an unknown `type` is skipped (a newer writer may have added one). An unknown **`VERSION`** makes the tool refuse to
  *write* and read read-only with a warning, so an old checkout cannot corrupt a newer ledger.
- Every record is size-capped (8 KB). Anything larger is truncated before it is written, never the whole line dropped.

### Writing is narrow

- One `fs.appendFileSync` of one `\n`-terminated line per event. Each is far below `PIPE_BUF` and goes to a file only its run writes.
- Files are created `0600` and the directory `0700`. The ledger can name bugs and test failures; it is not for other users on a shared
  machine.
- `runId` is validated with the existing `isValidRunId` rule and **hashed** into file names when it contains anything unusual, so a run id
  cannot traverse out of `runs/`. Idempotency keys are hashed (SHA-256, first 32 hex digits) into `keys/` file names for the same reason;
  the readable key is stored inside the file.

### Secrets

Everything that reaches the ledger passes through `redactSecrets` first, the same function the triage report uses, and fingerprints are
computed from the masked text (already true in Phase 2). `action.failed` stores an error **code** and a masked, truncated message.
Nothing in the ledger is ever needed to authenticate to anything.

### The ledger never grants permission

It can only **suppress** (an action already done, an attempt cap reached, a lock held) or **record**. It can never turn a `propose` into
an `act`, and nothing in it is read as an instruction. This matters because the ledger is a plain file a person or a prompt-injected edit
could alter: the worst a forged ledger can do is *suppress* a filing (a missed bug report, visible in the run summary as "skipped:
already filed (ledger)"), not cause a write the policy forbids. The tracker's body marker stays the source of truth for dedupe; the
ledger is a fast path and a crash record on top of it.

## Idempotency and resume

Today: `post-tests` writes a keys file and passes `idempotencyKey` to the adapter, which embeds a marker in the created item so a retry
can find it; `plan.js` builds keys that include the run id. Phase 3 keeps the adapter marker (it is what survives a lost ledger) and
moves the *record* of it into the ledger.

The claim protocol, for any external write:

1. **Claim** the key (`wx`). Won → go to 3. Lost → read the existing claim.
2. Existing claim is `done` → **skip**, return the recorded result with `deduplicated: true`. Existing claim is *in flight* (claimed, no
   `done`, and its run has no `run.end` or is another live run) → this is the ambiguous case: the previous process may have created the
   item on the tracker before dying. **Reconcile before retrying:** search the tracker for the key's marker (the mechanism already used
   for fingerprints). Found → adopt that item as the result and mark the claim `done`. Not found → retry under the same claim.
3. **Do the write**, passing the same `idempotencyKey` to the adapter, then **complete** the claim (atomic temp-file + rename) with the
   result id.

Why reconcile-by-search instead of trusting the claim: *a claim proves intent, not effect.* The kill can land between the HTTP call
returning and the claim being completed. Without the search, resuming either duplicates the item (retry blindly) or drops it
(trust "claimed"). The search is the same one the planner already does by fingerprint marker, so it needs no new adapter surface; its
known weakness, index lag on very recent items, is reported rather than hidden ("could not confirm; retrying under the same key, and the
adapter's marker will dedupe if the item exists").

`post-tests` and the `file-bug` flow both go through the same two functions (`claim`, `complete`) in `scripts/ledger/`, exposed to the
prose commands as `node scripts/ledger/cli.js claim|complete|fail|status`. The `.ticket-context/<parent>-test-keys.json` file is still
**read** (a project mid-flight at upgrade keeps its progress) and still **written** as a human-readable receipt, but the ledger is what
decides "already done".

**Resume** means re-running with the same `--run-id` (or the same ticket for `post-tests`). Completed external writes are skipped by key;
the test run itself repeats (documented Phase 2 limit: whole spec files re-run). No step is "continued from the middle".

## Flake rate, attempt caps, known bugs

All three are *views* computed from events, not extra state, so they cannot drift from the log:

- **Flake rate** per test (spec + name) over a window (default last 20 runs that contain it): runs where it flipped between `main` and a
  re-run ÷ runs where it was seen. Reported in the run summary and `ledger flake-rate`. **Report-only**, as decided in Phase 2.
  Quarantine stays Phase 5.
- **Heal attempt cap** per fingerprint: `triage.selfHeal.maxAttemptsPerFingerprint` (default 1 per 7 days). `heal.js` reads the count
  before it starts and refuses with a named reason when the cap is reached. This is the cross-run cap Phase 2 deferred. A `heal.begin`
  with no `heal.end` counts as an attempt (a crash used one).
- **Known bug from the ledger:** `plan.js` consults `action.done` records for the fingerprint *before* tracker search. A hit becomes
  `comment-existing` with `source: "ledger"` and a warning that the tracker was not consulted for it. A miss falls through to search as
  today. This is the index-lag protection. If the tracker later says the issue is closed, the existing regression logic applies as before.

## Locks

Scopes: `env:<normalized testEnvironmentBaseUrl>` (two runs must not hammer one staging) and `ticket:<id>` (two runs must not post the
same ticket's tests concurrently). A lock is a file created with `wx` containing `{ pid, host, runId, startedAt, ttlMs }`.

- **Acquire** `wx`; on `EEXIST` read it. If it is stale — same host and the pid is dead, or older than its TTL (default 2 hours) — it
  may be **stolen**, and the steal is recorded in the audit log. Otherwise the new run exits `4` ("locked by run X since T") without
  touching anything.
- **Release** in a `finally` and on `SIGINT` / `SIGTERM` / `SIGHUP`, reusing the signal handling pattern from `heal.js` (including the
  two-turn `setImmediate` wait that lets a signal queued during a synchronous step run before the handlers are disarmed).
- **Honest limit:** a file lock only protects one machine. Two CI runners do not share `.qa-ledger/`, so cross-machine exclusion is
  the CI system's job (`concurrency:` groups in the Phase 4 workflow templates). This document does not pretend the lock covers it.
- **Per-ticket cooldown:** `budget.cooldownMinutes` (default 0 = off) refuses a new run for a ticket whose last `run.end` is more recent
  than that. Computed from the ledger, so it survives a restart.

## Budgets

Three limits: wall-clock, turns, cost.

- **Wall-clock** is enforceable by the scripts: `orchestrate.js` already has `--timeout-ms` per step; Phase 3 adds a whole-run deadline
  (`budget.maxWallClockMs`) that stops starting new steps and ends the run with `complete: false` and a `budget` event naming what was
  exceeded.
- **Turns and cost** can only be enforced by whatever launches the model (`claude -p --max-turns …`, which is Phase 4's
  `run-autonomous.sh`). Phase 3 defines the config keys (`budget.maxTurns`, `budget.maxCostUsd`), records what the caller reports at
  run end (`--output-format json` includes the cost), and exposes `ledger budget-check` so the Phase 4 wrapper has one call to ask
  "may I start?". **Phase 3 does not claim to enforce what it cannot see**; the summary says "not measured" when the caller supplied
  nothing.

All three keys are optional and default to off, so nothing changes for a project that sets none of them.

## Reporting

`scripts/report.js --run-id <id>` (the parent plan says `report.sh`; it is Node here, like every other script in `scripts/`, so it
shares `redactSecrets` and the schema validator) reads one run's events and renders markdown:

- header: outcome, duration, framework, counts, whether the run finished (`run.end`);
- table of failures with class, confidence, action taken (or why none), and the tracker item (with `(ledger)` when it came from the
  ledger rather than a search);
- flaky tests with their cross-run rate;
- warnings: lookups that could not see everything, skipped steps, a stale heal branch, budget notes;
- what was **not** done and why (a lock, a cap, a propose), so a quiet run is distinguishable from a skipped one.

Outputs: stdout; `$GITHUB_STEP_SUMMARY` when set; a ticket-comment **input file** in the same shape `plan.js` already writes (posting it
stays behind the existing gate; Phase 4 decides the tier). **Slack:** if `QA_SLACK_WEBHOOK` is set, one POST of the summary,
`--slack-only-failures` to stay quiet on green. It is an outbound write to a URL taken from the environment, so: `https` only; the host
must match `hooks.slack.com` or a host named in `qa-config.json`; the body is the already-masked summary, size-capped; a failure to post
is a warning, never a failed run.

The summary is deterministic text from events, not model-written, so it renders identically for pass, fail and error and can be
snapshot-tested.

## Config

One new optional block in `qa-config.schema.json` (schema stays backward compatible; absent means today's behaviour):

```json
"ledger": { "dir": ".qa-ledger", "retentionDays": 90 },
"budget": { "maxWallClockMs": 0, "maxTurns": 0, "maxCostUsd": 0, "cooldownMinutes": 0 },
"triage": { "selfHeal": { "maxAttemptsPerFingerprint": 1 } }
```

`0` means "no limit". Flags override config, as everywhere else, and the output says which source each setting came from.

## Build plan

One PR for the phase (as `v2-plan.md` says), built as five commits so a reviewer can read them in order. Each lands with its tests.

1. **Ledger core.** `scripts/ledger/{lib,cli}.js`, `schemas/ledger-record.schema.json`, `.gitignore`, the config block. Append and read,
   key claim/complete, locks, prune. Nothing else uses it yet.
2. **Events from the loop.** `orchestrate.js`, `heal.js` write `run.*`, `test.result`, `verdict`, `heal.*`. Flake rate, the heal cap,
   the stale-heal-branch report.
3. **Idempotent writes.** `post-tests.js` and the `file-bug` flow claim/complete through the ledger; `plan.js` consults it before search;
   the keys file is read for compatibility.
4. **Budgets, locks, cooldown** wired into `orchestrate.js` and `post-tests.js`; `ledger budget-check`.
5. **Reporting.** `scripts/report.js`, the Slack path, `$GITHUB_STEP_SUMMARY`, the docs and the `/run-and-triage` command's last step.

`docs/autonomy.md` is Phase 4's. This phase documents the ledger in `docs/ledger.md` (operator's view: layout, how to read a run, how
to prune, what to do after a crash).

## Verification

Exit criteria from the parent plan, and how each is shown:

| Criterion | Test |
|---|---|
| Re-running the same ticket twice creates zero duplicates | `post-tests` twice against the mock tracker, with the ledger present, with it deleted (the adapter marker must still dedupe), and with only the old keys file |
| Killing a run mid-batch and resuming completes without duplicates | a child process running `post-tests` against a mock that `SIGKILL`s it after the Nth create returns and before the claim completes (the ambiguous window), then a resume; assert N+rest items exist exactly once |
| Summary renders for pass, fail and error | snapshot tests on fixed event files for green, triaged failures, a crashed run (no `run.end`), and a budget stop |

Plus what the design promises specifically:

- two processes claiming one key: exactly one winner; N processes, still one;
- torn final line, torn middle line, unknown record type, unknown `VERSION`, oversized record;
- lock: held by a live pid, stale by dead pid, stale by TTL, released on each signal, stolen and audited;
- a hostile run id and a hostile key cannot leave `runs/` / `keys/`;
- a secret in a failure message is masked before it reaches any file;
- a forged ledger can suppress but never enable: a `propose` verdict stays `propose` whatever the ledger says;
- the heal cap blocks the second attempt and counts a crashed attempt;
- a ledger hit and a tracker hit for the same fingerprint agree on the step; a stale ledger entry for an item the tracker now shows closed
  routes to the regression logic;
- the Slack path refuses `http`, an unlisted host, and an oversized body, and a post failure does not fail the run.

Fault injection uses real child processes and real signals (the dev sandbox cannot bind ports, so the tracker and Slack mocks stay
in-process `fetch` mocks, as in Phase 1).

## Limits (documented now, not fixed)

- **Single machine.** Locks and the ledger are local files. Cross-machine safety is the CI system's concurrency control plus the
  tracker's marker dedupe.
- **JSONL scans.** Cross-run views read every run file in the window. Fine for dozens of runs a day; if trend analysis over thousands of runs is
  wanted, that is the moment to revisit SQLite (decision 1 allows it).
- **The ledger is not tamper-proof.** It is a plain file (see "never grants permission"). A hash chain on `audit.jsonl` would make edits
  detectable; it is cheap and is listed as a stretch for the review to accept or drop.
- **Index lag still exists** for items the ledger never saw (filed by a person, or by another machine). Only the tracker marker covers
  those, with the Phase 2 caveat.
- **Cost and turns are not measured by the scripts**, only recorded when the caller reports them.
- **Not verified against real services**, by decision 2.

## Open questions for review

1. Is 90 days of run files and 400 days of keys the right retention?
2. Should `audit.jsonl` get the hash chain (tamper-evidence) in this phase?
3. Default heal cap: 1 attempt per fingerprint per 7 days. Too tight, too loose?
4. Should the ticket comment from `report.js` be an input file only (proposed), or may a later tier post it directly?

## What the build changed

Written as the build goes, below the plan, which is left as it was.

### Slice 1: the ledger core

- **The proposed defaults were accepted as planned** (2026-11-13: "continue with phase 3 as planned"): `.qa-ledger/` gitignored, 90 days of run files, 400 days of keys, Slack only to `hooks.slack.com`. The open questions (hash chain on `audit.jsonl`, heal cap, report comment) stay open and are taken up in the slice that needs each.
- **Taking over a failed claim or a stale lock was first built wrong, and a race test caught it.** The first version moved the old file aside and then created the new one. In that gap the path is empty, so a third caller could claim it the ordinary way, and the caller that had just moved a *fresh* claim aside could not put it back: two callers each believed they had won (2 winners out of 8 in the first race test). It is now a **guarded, atomic replace**: one caller at a time holds `<file>.guard` (created with `O_EXCL`), re-reads the file to confirm it is still the failed claim or stale lock it judged, and renames a temp file over it, so the path is never empty and everyone else's ordinary claim (`O_EXCL` create) can only lose. Tests: eight real processes racing for one failed key and for one stale lock (exactly one winner each), and two tests that change the file between "judged stale" and "took the guard".
  What is left, and documented: a guard older than a minute is treated as a dead holder's and removed once; a live owner whose TTL ran out can still release at the very moment it is replaced.
- **The run-id helpers moved** from `scripts/triage/plan.js` to `scripts/lib/ids.js` (the planner re-exports them), so the planner's keys and the ledger's file names follow one rule. Moving them also corrected a stale comment (a hashed run part is 37 characters, not 33).
- **File names fold case.** On a case-insensitive disk (macOS) the run ids `Run` and `run` would share a file; any id with an upper-case letter now gets a hash suffix. This was not in the plan.
- **Only the `ledger` config block landed in this slice.** `budget` and `triage.selfHeal.maxAttemptsPerFingerprint` are added with the slices that read them (4 and 2): a documented key nothing reads is worse than none, and the config tests hold the schema to the loader.
- **`docs/ledger.md`** (the operator's guide) comes with slice 5, when the behaviour it describes is complete.

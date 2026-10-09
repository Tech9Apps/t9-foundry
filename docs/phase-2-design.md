# Phase 2 design: run → triage → act

Status: **first implementation checkpoint done** on `v2/phase-2-closed-loop` (stacked on Phase 1, PR #8). Everything
below is built and tested except self-heal, which is **not** built and is an open decision (see Questions).

## What was built, and where the build changed the design

| Piece | Where |
|---|---|
| classifier, fingerprints, locator evidence | `scripts/triage/{classify,fingerprint,locators}.js`, `lib/text.js` |
| planner (read-only tracker dedupe) | `scripts/triage/plan.js` |
| the loop's spine: run → re-run failing specs → evidence → classify → plan | `scripts/triage/orchestrate.js` |
| binding rubric; agent; command | `.claude/memory/failure-triage-rules.md`, `.claude/agents/QA-run-orchestrator.md`, `.claude/commands/run-and-triage.md` |
| four seeded scenarios, run for real | `demo/scenarios/` (goldens by hand in `manifest.json`), `tests/triage/scenarios.test.js` |
| prose-vs-code drift checks | `tests/helpers/{triage-rubric-check,orchestrator-drift-check}.js`, `tests/triage.bats` |

Changes the build forced (each found by a test, not by thought):
- **`orchestrate.js` was not in the plan.** Six steps of choreography in prose is where a model errs; one command is not.
- **Normalized `open` on tracker search results** (all five adapters), as designed — but building it also exposed a **Phase 1
  Azure bug**: bug bodies live in Repro Steps, which `search` and `fetch` never read. Fixed, with a contract test every
  adapter now runs and an Azure mock that matches per field like real WIQL.
- **A missing element must never count as an assertion failure.** Runners report both with the same plain kind, so without
  this a stale selector with no DOM evidence classified as a product bug at 0.85. Fixed in the classifier.
- **TST-2 ignores the runner's error kind** (most runners cannot tell a crash from an assertion; it uses the wording and
  the first stack frame instead).
- **The `node` results recipe emits TAP**, not JUnit: re-running only the failing specs needs the file location.
- **An outage scenario needs a real name-resolution failure** (`.invalid`), because a dead local port reports `EPERM` in a sandbox.

## The loop

```
preflight ─▶ run ─▶ re-run failing specs ×N ─▶ classify ─▶ plan actions ─▶ act ─▶ report
 (shell)    run.js      run.js --spec …        classify.js   plan.js     existing,   agent
                                                                         gated cmds
```

The principle: **code decides what evidence can settle; the model decides the rest; the rubric binds both.**

| Step | Who | How |
|---|---|---|
| preflight, run, re-run | scripts | `scripts/preflight.sh`, `scripts/results/run.js` (Phase 1). Re-runs write to `qa-results/rerun-<k>/`. |
| collect extra evidence | model | DOM snapshot, screenshots, "is the element there under another selector?" — passed to the classifier as `--evidence` JSON. |
| classify | **code** | `scripts/triage/classify.js`: ordered rules, first match wins, returns class + confidence + the rule id + the evidence it used. |
| decide the action | **code** | `scripts/triage/plan.js`: fingerprints each product-bug, searches the tracker, returns `file-bug` / `comment-existing` / `file-regression` / `propose`. Read-only. |
| act | existing gated commands | `/file-bug` (human review gate) or `cli.js comment`. Autonomy tiers that remove the gate are Phase 4. |
| report | model | summarizes the triage report; never re-labels a failure the classifier proposed. |

The agent is `.claude/agents/QA-run-orchestrator.md`; the binding rubric is `.claude/memory/failure-triage-rules.md`.
A drift test ties the rule ids in the rubric to the ones in code, as in Phase 1.

## Classes

`product-bug` · `test-bug` · `flaky` · `environment` — from the Phase 2 plan — plus **`undetermined`**.
Forcing one of four labels when the evidence doesn't support any is how a triage system earns distrust, so a failure with
no rule above the confidence floor is reported as `undetermined` and always `propose`s. (Question 2.)

Every verdict carries `confidence` (0–1), `rule` (e.g. `FLK-1`), `evidence[]` (human-readable, each citing where it came
from) and `action: "act" | "propose"`: **`act` only when `confidence ≥ threshold`** (default 0.8, `--threshold`), else
`propose` — regardless of any future autonomy tier.

## Rules (first match wins; per failing test)

"Attempts" are the outcomes of the same test (same `ticket/caseId`, else file + name) across the main run and re-runs.

| Id | Class | When | Conf. |
|---|---|---|---:|
| ENV-1 | environment | preflight reported failure | 0.95 |
| ENV-2 | environment | **every** failing attempt's error matches an infrastructure signature (`ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, `EAI_AGAIN`, `getaddrinfo`, `net::ERR_CONNECTION*`/`NAME_NOT_RESOLVED`, `502/503/504`, `Bad Gateway`, `Service Unavailable`). A bare "timeout exceeded" is **not** a signature — it is ambiguous. | 0.90 |
| FLK-1 | flaky | attempts contain both a pass and a fail (flip), or the runner itself flagged `flaky` | 0.90 / 0.85 |
| TST-1 | test-bug | locator-not-found in every failing attempt **and** evidence names exactly one candidate element under a different selector | 0.85 |
| TST-2 | test-bug | the test **crashed** (`kind: error`, not an assertion) with a `TypeError`/`ReferenceError`/`SyntaxError`/`Cannot find module` whose first stack frame is in a test file | 0.80 |
| TST-3 | test-bug | locator-not-found in every failing attempt, DOM evidence shows the id is absent and **two or more** elements resemble it — renamed, but which? | 0.55 |
| ENV-3 | environment | ≥ 3 tests and ≥ 50% of the run failed with the **same** error signature (blast radius) — could equally be a real suite-wide regression, so it is only a proposal | 0.60 |
| PRD-1 | product-bug | every attempt failed (≥ 2), assertion failures (`kind: failure`) with the **same signature**, test traceable to a manual case (`caseId`) | 0.85 |
| PRD-2 | product-bug | as PRD-1 but not traceable to a case | 0.75 |
| PRD-3 | product-bug | a **single** attempt (no re-run was done), assertion failure — a flake cannot be ruled out | 0.60 |
| PRD-4 | product-bug | the **application threw**: an error (not an assertion) whose first stack frame is application code — consistent, or seen once | 0.55 |
| UND-1 | undetermined | **nothing above found any positive evidence**, for one named reason (see "Undetermined is strict") | 0.50 / 0.40 / 0.30 |

Why the order: environment signatures and flips are the cheapest, most reliable evidence, so they go first; a consistent
assertion failure is the *weakest* positive claim ("the app is wrong" rather than "the test is wrong"), so it goes last
and is capped lower when it cannot be tied to a documented expectation.

## Undetermined is strict

Decided with the user: keep the class, but make it hard to reach — "we don't want to jump straight to undetermined every time
something is different." So:

1. **A closed list of reasons**, each with its own confidence: `LOCATOR_NO_EVIDENCE`, `LOCATOR_PRESENT`, `LOCATOR_GONE`,
   `CONSISTENT_TIMEOUT`, `NOT_RERUN`, `UNSTABLE_ERRORS`, `UNATTRIBUTED_CRASH`, `UNCLASSIFIED`. Every undetermined verdict carries exactly one.
2. **Positive evidence wins.** Two weak rules (TST-3, PRD-4) give the common "different" cases a class at a low confidence instead:
   a renamed locator with several lookalikes is a `test-bug`, an exception thrown in application code is a `product-bug`. Both are
   proposals. Only when no rule finds any positive evidence is a verdict undetermined.
3. **Never acts**, whatever the threshold (even set below its confidence).
4. **Evidence first.** `LOCATOR_NO_EVIDENCE` and `NOT_RERUN` mean "go and get the evidence": the agent must capture the DOM snapshot or
   re-run, and re-classify, *before* reporting.
5. **A witness.** If at least 3 failures and at least half of a run's failures are undetermined, the output carries a warning that
   the evidence or the rules are missing for this suite and that these are not findings. A high share is a signal about the rules.

## Fingerprints and bug dedupe

`fingerprint = sha1(identity | errorKind | signature)[0:12]`:
- **identity** — `ticket/caseId` when the test name carries one (survives renames and refactors), else
  `<file basename>|<normalized title>`;
- **signature** — the error message with the volatile parts masked: ANSI, UUIDs, ISO timestamps, long hex/ids, durations
  (`30000ms`), temp and absolute paths, ports, `file:line:col`.

`plan.js` then, per product-bug:
1. searches the tracker for the fingerprint token (written into every filed bug as `qafp<12 hex>`, one alphanumeric
   token because tracker search tokenizers split on hyphens);
2. **open match** → `comment-existing` (a ready-to-run `comment` input with a per-run idempotency key);
3. **only closed matches** → `file-regression`: a *new* bug that links the closed one — a closed bug with the same
   fingerprint is a regression, and idempotency-key lookup (which matches closed items too) must **not** swallow it, so
   the key includes the run id (`fp-<fingerprint>-<runId>`: a retry of the same run is safe, a later run is new);
4. **no match** → `file-bug`.

This needs a normalized open/closed on search results, which Phase 1's `search` lacks (each tracker returns its own
status words). Adapters gain `open: boolean`, mapped per tracker and covered by the contract suite.

**Known limit, stated up front:** GitHub's search index lags writes, so a bug filed minutes ago may not be found, and a
second run can file a duplicate. Within one run `plan.js` dedupes locally; across runs the Phase 3 ledger is the fix.
`smoke.js` gains a check that a body-marker token is found by search, so a real tracker shows whether this works.

## Flake handling

A flaky verdict **never** files a bug. It is reported with its flip counts and written to `qa-results/flaky.json`.
Tagging/quarantining test files is a code change and waits for the self-heal decision; the cross-run flake *rate* waits
for the Phase 3 ledger.

## Seeded scenarios (the exit criterion)

The demo app gains four scenarios, each producing **real** failing output from a real run, so the classifier is tested on
real strings, not invented ones:

| Scenario | Seeded how | Expected verdict |
|---|---|---|
| real bug | the two planted bugs the demo already has | `product-bug` (PRD-1) |
| stale selector | a UI-level check against `public/index.html` whose test-id was renamed | `test-bug` (TST-1) |
| flaky | a check that fails on its first attempt and passes on the second (state in a temp dir) | `flaky` (FLK-1) |
| environment outage | a check that calls a port nothing listens on → real `ECONNREFUSED` | `environment` (ENV-2) |

CI runs them against mocks and the real node runner; no browser, no network.

## What will and will not be verified

Verified: the classifier, fingerprints and planner on real node:test output and tracker mocks; mutation-checked.
**Not** verified: classification quality on real Playwright/Cypress failures (the regex signatures are from experience
of those tools' messages, not from a corpus), tracker search behavior on real services, the orchestrator agent's prose
under a live model. The rubric thresholds are starting values, not tuned ones.

## Self-heal (v2.0)

The user decided self-heal ships in v2.0. It is the one place the harness edits code, so it is built **narrow enough to verify
mechanically**, not to trust a model's judgement.

**Scope: one fix.** A `TST-1` verdict (a locator was not found, the DOM evidence says the test-id is absent, **exactly one**
element resembles it) at `act` confidence → an exact **test-id rename** inside locator expressions in test code. `TST-2` (a crashed
test), `TST-3` (several lookalikes) and everything else stay proposals: they need judgement.

**Off by default.** `triage.selfHeal.enabled` (or `--heal`; `--no-heal` overrides the config). When off, the verdict still carries a
concrete `proposal` (`rename-testid: from → to`), so the report says exactly what the fix would be.

**What it may touch.** Only files under `triage.selfHeal.paths` (default `testFramework.testDir`, relative to the run directory, which must be
inside the git repository), with test-code extensions, never `node_modules`/`.git`/build output, never through a symlink. Application source
is never in scope.

**The edit, and the guard that makes it safe:**
- Only the id inside a locator expression changes: `getByTestId('x')`, `get_by_test_id("x")`, `[data-testid=x]` and its `data-cy`/`data-test-id`/`data-qa`
  forms, in any quoting. A bare string that merely equals the id (a constant, a comment) is **not** edited, and is reported as left untouched.
- Both ids must match `^[A-Za-z0-9_:.-]+$`. The new id comes from the page's HTML, which is not trusted: a quote or a bracket in it
  would be code injection into a test file, so it is refused.
- **Every changed line must equal the original line with only `new` swapped for `old`** (checked by reversing the substitution on the whole line). If a
  matcher, an expected value, or anything else differs, the heal is refused. This is the mechanical meaning of "never edits assertions".
- Caps: at most `maxFiles` files (default 5) and `maxLines` changed lines (default 20), else the heal is **refused**, not applied.

**Git, and the rules around it:**
1. Requires the repository's tracked files to be clean and a named branch (not detached). Otherwise refused — it never mixes its edits with yours.
2. Works on a new branch `qa/heal-<runId>` (the prefix is always under `qa/`, so it can never be a default branch). The branch must not already exist.
3. Applies the edit, then **validates by re-running** the failing spec files: every healed test must pass, and no test in those files that passed before may fail.
4. Pass → commit (only the edited paths, hooks respected) and return to the original branch. Fail, or any error → **revert everything**: restore the files, return to the
   original branch, delete the branch it created. The repository is left exactly as it was found.
5. **It never pushes**, and it has no code path that does. A branch exists locally; opening a PR needs the user's explicit approval, and the agent
   asks for it with the diff in view.
6. One attempt per failing test per run, no retry loop. A cross-run attempt cap needs the Phase 3 ledger.

**Not verified:** healing against real Playwright/Cypress projects (the locator patterns come from those tools' documented APIs; the real
run is `node --test` against a throwaway repository), and any git workflow that rewrites hooks/identity in unusual ways.

## Decisions (the user's answers)

1. **Self-heal: in v2.0.** Designed below, built on its own branch.
2. **Undetermined: keep it, but strict** (above).
3. **A closed bug with the same fingerprint: file a new regression bug that links it** (as designed).
4. **Re-runs: default 2, configurable** — `triage.reruns` in `qa-config.json` (0–5) or `--reruns`; a flag beats the config.
   The confidence threshold is configurable the same way (`triage.confidenceThreshold`, `--threshold`).
5. **Flaky tests: report-only for now.**

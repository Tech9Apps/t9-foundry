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
| decide the action | **code** | `scripts/triage/plan.js`: fingerprints each product-bug, searches the tracker, returns `file-bug` / `comment-existing` / `file-regression` / `report-dismissed` / `propose`, and writes each comment input to a file named by the fingerprint token. Read-only toward the tracker. |
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
| ENV-2 | environment | **every** failing attempt's error matches an infrastructure signature (`ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, `EAI_AGAIN`, `getaddrinfo`, `net::ERR_CONNECTION*`/`NAME_NOT_RESOLVED`, `502/503/504`, `Bad Gateway`, `Service Unavailable`). A bare "timeout exceeded" is **not** a signature — it is ambiguous. **Exception:** when preflight said the environment was ready, no attempt passed, and every error is only an HTTP status or a failed fetch (no network-level error), the confidence is 0.70 and it is a proposal: a CORS rule, a removed route or a regression looks the same. In HTTP comparisons the other side must itself be 100-599 (`503 !== 600` is data). | 0.90 / 0.70 |
| FLK-1 | flaky | attempts contain both a pass and a fail (flip), or the runner itself flagged `flaky` | 0.90 / 0.85 |
| TST-1 | test-bug | locator-not-found in every failing attempt **and** evidence names exactly one candidate element under a different selector | 0.85 |
| TST-2 | test-bug | the test **crashed** (not an assertion) and the first stack frame is in a test file below the project root. a plain `ReferenceError`/`SyntaxError`/"is not defined" in the test's own code: 0.80; anything the app can cause (`TypeError`, "is not a function", `Cannot find module`, a "not valid JSON" `SyntaxError`, a `ReferenceError` through `page.evaluate` or "originated from your application code"): 0.65 | 0.80 / 0.65 |
| ENV-3 | environment | ≥ 3 tests and ≥ 50% of the run failed, and one error signature accounts for ≥ 80% of those failures (blast radius) — could equally be a real suite-wide regression, so it is only a proposal | 0.60 |
| PRD-1 | product-bug | every attempt failed (≥ 2), assertion failures (`kind: failure`) with the **same signature**, test traceable to a manual case (`caseId`) | 0.85 |
| PRD-2 | product-bug | as PRD-1 but not traceable to a case | 0.75 |
| PRD-3 | product-bug | a **single** attempt (no re-run was done), assertion failure — a flake cannot be ruled out | 0.60 |
| UND-1 | undetermined | locator-not-found with no evidence / several candidates / none; consistent timeouts with no infrastructure signature; anything else | ≤ 0.50 |

Why the order: environment signatures and flips are the cheapest, most reliable evidence, so they go first; a consistent
assertion failure is the *weakest* positive claim ("the app is wrong" rather than "the test is wrong"), so it goes last
and is capped lower when it cannot be tied to a documented expectation.

## Fingerprints and bug dedupe

`fingerprint = sha1(identity | errorKind | signature)[0:12]`:
- **identity** — `ticket/caseId` when the test name carries one (survives renames and refactors), else
  `<file basename>|<normalized title>`;
- **signature** — the error message **plus the `Expected` / `Received` / `Locator` lines of its details**, with the volatile parts
  masked: ANSI, UUIDs, ISO timestamps, long hex/ids, durations (`30000ms`), temp and absolute paths, ports, `file:line:col`. The
  expected/received lines are part of it because two defects can share a one-line summary (`expect(received).toBe(expected)`) and
  differ only in what was received; the call log and the stack are left out because they change from run to run.

`plan.js` then, per product-bug:
1. searches the tracker for the fingerprint token (written into every filed bug as `qafp<12 hex>`, one alphanumeric
   token because tracker search tokenizers split on hyphens);
2. **open match** → `comment-existing` (a ready-to-run `comment` input with a per-run idempotency key);
3. **only matches closed as fixed** → `file-regression`: a *new* bug that links the closed one — a closed bug with the same
   fingerprint is a regression, and idempotency-key lookup (which matches closed items too) must **not** swallow it, so
   the key includes the run id (`fp-<fingerprint>-<runId>`: a retry of the same run is safe, a later run is new);
4. **only matches closed WITHOUT a fix** (won't fix, not planned, duplicate, rejected) → `report-dismissed`: nothing is filed or
   commented. The team decided not to fix it, so it is not a regression of a fix, and a comment on it is noise. When BOTH kinds match, the
   **later** report (by `createdAt`) is the last decision: fixed, then a regression report that was dismissed → `report-dismissed` (otherwise a
   regression would be filed on every run); dismissed, then a later fix, then back → `file-regression`. If either side has no date the order is
   unknown and the plan stays with `file-regression`, with a note telling a person to check;
5. **no match** → `file-bug`.

The lookup is honest about what it did not see. A matching search result that cannot be fetched is skipped (it does not hide the ones that could be read)
and listed under `lookup.partial` with a warning; a search that returns as many results as it asks for (5) may have more behind them, so that is
flagged `lookup.truncated`. A `file-bug` after a partial lookup says so in its `note`. The run's part of the idempotency key is the run id as given when
it is short and made of safe characters; otherwise a readable prefix plus a hash of the whole id, so two different run ids can never share a key. The text
of a failure that is copied into a report, a comment or a bug (message, details, evidence lines, signature, test title) passes through `redactSecrets`:
PEM private keys, provider tokens and webhook URLs, credentials in a URL, authorization and cookie headers with a real value, and any `key=value` / `"key":"value"`
whose key names a secret (any prefix: `aws_secret_access_key`, `csrf_token`). The prose form `key: value` is masked only when the value looks like a secret, so an
assertion about a validation message (`Expected: "Password: required"`) keeps its evidence. Text is masked BEFORE it is cut, so a secret straddling a cut is not
left half-visible. The fingerprint is computed from the original, so masking never changes it. Not covered: `qa-results/main/result.json` and the test runner's own
output stay raw; this protects what the triage tools copy elsewhere.

**Jira is not covered.** The tracker adapters (and so the lookup, regression and dismissed logic above) exist for GitHub, GitLab, Bitbucket, Azure
DevOps and ClickUp. Jira is reached only through the Atlassian MCP, interactively, so with `ticketSource.type: jira` `plan.js` has no adapter: it warns
("no tracker lookup … filing may duplicate") and every product bug is `file-bug`, on every run, whether or not a report for it exists. Search Jira yourself
for the fingerprint token before approving a filing.

This needs a normalized state on search results, which Phase 1's `search` lacks (each tracker returns its own status words).
Adapters gain `open: boolean` and, when the tracker says the item was closed without a fix, `dismissed: true`, mapped per
tracker (GitHub "not planned" and wontfix/invalid/duplicate labels, Bitbucket's wontfix/invalid/duplicate, ClickUp status
wording, Azure close reasons, GitLab labels) and covered by the contract suite and `tests/tracker/dismissed.test.js`.

**Known limit, stated up front:** GitHub's search index lags writes, so a bug filed minutes ago may not be found, and a
second run can file a duplicate. Within one run `plan.js` reports the SAME test failing the same way twice (the same case in two browser projects) once, as `duplicate-in-run`; it does
not merge DIFFERENT tests that happen to share an error, because each may be a different defect: those are separate reports. Across runs the Phase 3 ledger is the fix.
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

Verified: the classifier, fingerprints and planner on real node:test output and tracker mocks. Mutation-checked in two senses, and the second is the honest one: the author mutated each new check as it was written, and a later independent review ran about 310 further hand-made mutants, of which about 90 survived (most not equivalent). The survivors that guard a decision are now tests; what remains untested is individual wording patterns (each infrastructure/auth/locator phrase is covered by the patterns table, not one test each) and some diagnostic caps.
**Not** verified: classification quality on real Playwright/Cypress failures (the regex signatures are from experience
of those tools' messages, not from a corpus), tracker search behavior on real services, the orchestrator agent's prose
under a live model. The rubric thresholds are starting values, not tuned ones.

## Questions for the user

1. **Self-heal: v2.0 or v2.1?** This design stops at *propose* for `test-bug` (it names the candidate selector; nothing
   is edited). Self-heal adds a branch `qa/heal-<run-id>`, edits to page objects only, re-run validation, a PR, attempt
   caps. It is the riskiest part and shares the "agent edits code" boundary with Phase 4's tiers.
2. **Is a fifth class, `undetermined`, acceptable?** The plan listed four.
3. **A closed bug with the same fingerprint:** file a new regression bug that links it (this design), or comment on the
   closed one? There is no "reopen" operation in the adapters.
4. **Re-run budget:** default 2 re-runs of each failing spec, including product-bug candidates (it is what separates PRD-1
   from PRD-3). More cost, much better signal. OK?
5. **Flaky tests:** report-only in Phase 2 (this design), or tag/quarantine them now?

## What review of the first version changed

An independent review of the first version found that it classified on the wrong text and then trusted its own classification
too far. What changed, and why:

- **The classifier now reads the whole failure, not its first line.** Reporters put a one-line summary in `message` and the
  diagnosis in `details`. Playwright's `Received: <element(s) not found>`, the status a request got back and the locator it
  was waiting for were all in `details`, so a stale selector, an expired session, a 503 and a 404 page were classified as a failed
  assertion about the app: `product-bug`, 0.85, `act`, a bug filed. The seeded scenarios use TAP, whose message is whole, so
  nothing exercised that path. `tests/triage/realworld.test.js` now runs failures as the real Playwright reporter writes them
  through the real parser.
- **Three kinds of failure are not evidence about the app:** infrastructure errors (more of them recognised: certificate and TLS
  errors, empty responses, "Received: 503"), login/authorization signals (a 401/403, a redirect to a login page) and error pages
  (404/500). The last two become `undetermined` and say what to check, never a product bug.
- **A runner format that has not been verified on real failures cannot act.** `product-bug` and `test-bug` (the two classes with a
  side effect) are held at `propose` and marked `cap: unverified-format`. Only TAP is trusted by default; `--trusted-formats`
  widens it. This is the backstop for patterns nobody thought of yet: a wrong guess costs a human a look, not a bad ticket. It is not hypothetical: the
  first real Jest and Playwright runs (`tests/fixtures/results/real/`) found a Playwright action timeout classified as a product bug at 0.85, and a found
  element with the wrong text read as a stale selector. Both are fixed; those formats stay capped because one app is thin evidence.
- **Fingerprints include what was expected and received,** so two different defects with the same one-line summary no longer
  collide (the second used to be reported as "already filed").
- **The orchestrator agent has no `Write` tool and no longer claims it "cannot edit files".** It has Bash, so the honest statement
  is that not editing is a rule it keeps, not a sandbox. The scripts write the files the pipeline needs: `plan.js` writes each
  comment input to `comments/<token>.json`, and `locators.js --report … --token … --evidence-out` writes the evidence file.
- **Nothing free-text from a failure reaches a command line or a file name.** Test keys come from test titles (slashes, pipes,
  quotes); the prose now passes only the fingerprint token (`qafp` plus 12 hex digits) and the scripts read the report themselves.
- **Closed is not one thing** (see `report-dismissed` above).

## What the third review changed

A third independent review (about 310 hand-made mutants, a 20000-case fuzz, differential runs against `main`) found no blocker. What it found
were places where a real product bug could be reported as something else at a confidence that acts, and prose the drift checks did not protect:

- **TST-2** only acts for crashes the app cannot cause (ReferenceError, SyntaxError, missing module); a TypeError is 0.65. "A test file" is judged
  below the project root (`--root` / `--cwd`).
- **ENV-2** no longer matches a number that is not an HTTP status, and a healthy preflight followed by a weak signal (a bare 5xx, "failed to fetch")
  in every attempt is 0.70, a proposal.
- **Re-runs the runner cannot vouch for** (exit 3 with a report) are dropped, not counted: they used to turn a consistent failure into a flaky one.
- **DOM evidence** must be about the id in the failure it is applied to, and `evidence.json`, `snapshots/`, `triage.json`, `plan.json`, `flaky.json`
  and `comments/` from an earlier run are cleared at the start.
- **Idempotency keys** cannot collide across run ids; the tracker lookup reports what it could not read or see; failure text is redacted;
  a verdict token that is not a fingerprint token is refused (it names a file).
- **The drift checks** pin the agent's exact tool allowlist and the human-gate sentences.
- `triage.trustedFormats` never existed; the prose said it did. `--trusted-formats` is the only mechanism.
- **Second pass over those fixes** (the re-review found the same mistakes in other forms, and one regression of mine): clearing earlier runs' files
  is by ownership (name AND JSON shape), never by name alone, so a user's `snapshots/` or `plan.json` in `--out` survives; TST-2 "strong" excludes
  everything the app can cause (a body that is not JSON, `page.evaluate`, "originated from your application", a missing module), and a project root of
  `/` or empty turns directory patterns off; ENV-2 compares against status codes that exist; the locator scanner exposes every test attribute of an element,
  ends comments as HTML does and refuses (rather than cuts) a page over 64 MB; `redactSecrets` masks assignment syntax always and prose only when the value
  looks like a secret, and masks before it cuts; ClickUp reads "Closed as duplicate" and "Rejected by PM" as dismissed and "Rejected by QA" as active; the plan's
  lookup caveat rides on every step; `--run-id` takes any 1-128 printable characters (odd ones are hashed into the key); and the drift checks pin the exact
  LINE of every gate and a hash of each of the four safety-policy files (tests/helpers/triage-prose-pins.json): any change to the command, the agent, the rubric or
  `file-bug.md` fails the check until a person has read the diff and run `node tests/helpers/orchestrator-drift-check.js --write-pins`. (A line pin cannot see a new
  section that contradicts a gate; the hash can. The price is that editing those files means re-pinning them, on purpose.)
- **Accepted, documented:** results of a re-run repeat whole spec files (side effects included); trust is keyed on the format name, not the runner, so
  a TAP report from another producer fed straight to `classify.js` inherits TAP's privilege (the orchestrator only produces TAP from `node`).

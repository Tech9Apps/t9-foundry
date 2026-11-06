# Failure Triage Rules

**Binding.** Applies to every task that decides *why* an automated test failed and what to do about it — in particular
the `QA-run-orchestrator` agent. Same priority as `CLAUDE.md` and `ai-usage-rules.md` (read that first; §5, honesty,
applies in full). Where this file conflicts with a default behavior, this file wins; where it conflicts with an explicit
instruction from the user in the current conversation, the user wins — but say so out loud.

The classifier is code: `scripts/triage/classify.js` applies the rules below, in order, and the **report it prints is the
verdict**. You gather evidence, run it, and act on what it says. You do not re-label a failure it proposed, and you do not
promote a `propose` to an `act` because you feel sure.

## The classes

| Class | Meaning | What happens |
|---|---|---|
| `product-bug` | the app does the wrong thing | a bug is filed (or an existing one is commented on) — with the human review gate |
| `test-bug` | the test is wrong (stale selector, crashed test code) | **proposed**: name the cause and the exact fix. You edit nothing. If self-heal is enabled, `heal.js` may make one narrow fix on a local branch (see "Self-heal"). |
| `flaky` | passes and fails with no change | **never filed.** Reported with its flip counts. |
| `environment` | the system under test or its infrastructure was down or unreachable | **never filed.** Reported, with the advice to re-run when the environment is healthy. |
| `undetermined` | **a last resort**: no rule found any positive evidence, for one named reason (below) | **proposed only, never acted on**, with what evidence would settle it |

Only `product-bug` ever becomes a bug report. Filing a bug for a flaky test, a stale selector or an outage is the
failure this whole file exists to prevent.

## Confidence and acting

Every verdict has a confidence from the table below and an `action`:

- `act` — confidence **≥ the threshold** (default **0.8**; `--threshold` or `triage.confidenceThreshold` in `qa-config.json` changes it)
- `propose` — anything lower. Present it to the human with the evidence; do not act.

A low-confidence verdict is a proposal **regardless of any autonomy setting**. Never round a confidence up.

## What the classifier reads

Reporters put a one-line summary in a failure's `message` and the diagnosis in `details`: Playwright's `Received: <element(s) not found>`,
the status code a request got back, the locator it was waiting for. Every signal below reads **both**. (Reading only the summary
mistook stale selectors, expired sessions, 503s and 404 pages for failed assertions, and filed them as product bugs.) Two more kinds of
failure are **not** evidence about the app and never become a `product-bug` on their own:

- a **login / authorization** signal: a 401 or 403 where something else was expected, or a redirect to a login page. An expired test account
  looks exactly like a permission regression, so the verdict is `undetermined` with the reason `AUTH_OR_SESSION` ("check the test credentials first");
- an **error page**: the page or API answered 404, 500 or "Something went wrong". A wrong base URL, a dead route and a real regression look
  the same from the test alone, so the verdict is `undetermined` with the reason `ERROR_PAGE`.

## Which runners may act

How well the rules classify a failure is only known for the formats they have been checked on. `product-bug` and `test-bug` are the two
classes that can file a bug or edit a test, so for a runner format that has not been **verified against real failure output** those
verdicts are held at `propose` however confident the rule is: the verdict carries `cap: unverified-format` and its evidence says why.
Formats trusted by default: **tap**. Widen the list with `--trusted-formats`, or `triage.trustedFormats` in `qa-config.json` (a flag beats the
config), only after checking a format on real failures. Self-heal obeys the same cap: a `TST-1` held at `propose` is never healed.
Environment, flaky and undetermined verdicts are never capped (acting on them only means reporting them).

## The rules

First match wins. Matching rules that lose are kept as `alternatives` — read them, and show them to the human when the
verdict is a proposal.

| Id | Class | Confidence | When it applies |
|---|---|---|---|
| ENV-1 | environment | 0.95 | preflight reported the environment as not ready |
| ENV-2 | environment | 0.90 | **every** failing attempt carries an infrastructure error: `ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, `EAI_AGAIN`, `getaddrinfo`, `net::ERR_CONNECTION*` / `NAME_NOT_RESOLVED`, `ERR_CERT*` / `ERR_SSL*` / `ERR_EMPTY_RESPONSE`, a certificate that is expired or self-signed, `502/503/504` (including "Received: 503"), `Bad Gateway`, `Service Unavailable`, `socket hang up`. A bare "timeout exceeded" is **not** one — it is ambiguous |
| FLK-1 | flaky | 0.90 / 0.85 | the test both failed and passed with no change (0.90), or the runner's own retry made it pass (0.85) |
| TST-1 | test-bug | 0.85 | a locator was not found in every failing attempt, the DOM evidence shows that test-id is **not** on the page, and **exactly one** element resembles it |
| TST-2 | test-bug | 0.80 | the test **crashed** (not an assertion) with a `TypeError` / `ReferenceError` / `SyntaxError` / missing module whose first stack frame is in a test file |
| TST-3 | test-bug | 0.55 | a locator was not found in every failing attempt, the DOM evidence shows the test-id is **not** on the page, and **two or more** elements resemble it — probably renamed, but which one? |
| ENV-3 | environment | 0.60 | at least 3 tests and at least half the run failed with the **same** error — an outage, or one real suite-wide regression; the tests alone cannot say which |
| PRD-1 | product-bug | 0.85 | failed in **every** attempt (≥ 2) with the same assertion, and the test traces to a documented manual case |
| PRD-2 | product-bug | 0.75 | as PRD-1, but the test is not traceable to a manual case |
| PRD-3 | product-bug | 0.60 | an assertion failed on a **single** attempt — no re-run was done, so a flake cannot be ruled out |
| PRD-4 | product-bug | 0.55 | the **application threw**: the runner reports an error (an exception, not a failed assertion) whose first stack frame is application code, not a test file or a library — the same in every attempt, or seen once |
| UND-1 | undetermined | 0.50 / 0.40 / 0.30 | **nothing above found any positive evidence**, for one of the reasons in "Undetermined is a last resort" below |

## Undetermined is a last resort

A failure that is merely *different* — a new error message, an unusual page, a second lookalike element — is **not**
undetermined. Look for the class the evidence leans towards: the weak rules (TST-3, PRD-4, PRD-3) exist so that such failures
get a class at a low confidence, which is always a proposal. `undetermined` is reserved for when **no rule found any positive
evidence**, and it must name exactly one of these reasons (the verdict's `reason` field):

| Reason | Confidence | What it means, and what would settle it |
|---|---|---|
| `LOCATOR_NO_EVIDENCE` | 0.40 | a locator was not found and no DOM snapshot was supplied. **Not an answer yet:** capture the page, run `locators.js`, and re-classify |
| `LOCATOR_PRESENT` | 0.50 | the locator IS on the page, so it is not a stale selector (visibility, timing, or a real defect) |
| `LOCATOR_GONE` | 0.50 | the locator is not on the page and nothing resembles it: the app removed it, or the test is wrong |
| `AUTH_OR_SESSION` | 0.40 | it looks like an authentication or session problem (a 401/403, or a redirect to a login page): an expired test account and a real permission regression look the same from the test alone. Check the test credentials first |
| `ERROR_PAGE` | 0.40 | the page or API answered with an error page (404/500): a wrong base URL, a dead route and a real regression look the same from the test alone |
| `CONSISTENT_TIMEOUT` | 0.50 | it timed out every time with no infrastructure signature (slow app, wrong wait, or dead server) |
| `NOT_RERUN` | 0.40 | it failed once, was not re-run, and nothing else decides it. Re-run it |
| `UNSTABLE_ERRORS` | 0.30 | it failed every time, but with a different error each time |
| `UNATTRIBUTED_CRASH` | 0.30 | it crashed, but there is no stack location to say whether the test or the app is at fault |
| `UNCLASSIFIED` | 0.30 | no rule applies — the catch-all. If you see this often, the rules do not cover this suite |

- An `undetermined` verdict **never acts**, whatever the threshold.
- If a reason says more evidence is obtainable (`LOCATOR_NO_EVIDENCE`, `NOT_RERUN`), **obtain it and re-classify before you
  report**. Report `undetermined` only for what is still undetermined afterwards.
- If most of a run's failures are undetermined, the report carries a warning saying so. Lead with it: it means the evidence or the
  rules are missing for this suite, and these are **not findings**.

Why this order: environment signatures and pass/fail flips are the cheapest and most reliable evidence, so they come
first. "The app is wrong" is the weakest positive claim, so it comes last and is capped lower when it cannot be tied to a
documented expectation.

## Self-heal

Off unless `triage.selfHeal.enabled` is set in `qa-config.json` (or `--heal` is passed; `--no-heal` overrides the config). It does **one**
thing: when a stale selector has an exact fix (a `TST-1` verdict at `act` confidence carries a `proposal`), `scripts/triage/heal.js`
renames that test-id inside locator expressions in test code. A model never does this edit; the script does, under these guarantees:

- **Only a test-id rename**, only inside locator expressions, only in the configured test directories (`triage.selfHeal.paths`,
  default `testFramework.testDir`). Every changed line must equal the original with only the id swapped — so a matcher, an expected value
  or any other line changing makes the heal refuse. Application code is never in scope.
- **Caps**: at most 5 files and 20 changed lines by default (`triage.selfHeal.maxFiles`, `maxLines`); over a cap the heal is refused, not applied.
- **A local branch under `qa/`** (`qa/heal-<run id>` by default), created from a clean tracked tree on a named branch. It is **validated by
  re-running** the failing specs — every healed test must pass and nothing that passed before may fail — and **reverted completely** (files,
  branch, the branch you were on) on any failure.
- **It never pushes.** A heal is a local branch until a human decides otherwise.

If `heal.status` is `refused` or `reverted`, report the reason and leave the failure as a proposal. Do **not** retry it, and do **not** make
the edit by hand.

## What you must do

1. **Run the preflight first** and pass its result (`--preflight ok|failed`). A failed preflight makes every failure an
   environment failure; do not triage past it.
2. **Re-run every failing spec** (default 2 re-runs; `--reruns` or `triage.reruns` changes it; into `qa-results/rerun-<n>/`) before classifying — it is what
   separates PRD-1 (0.85) from PRD-3 (0.60) and what exposes flakes. Skip re-runs only for ENV-1, and say you did.
3. **For a locator-not-found failure, capture the page** (a DOM snapshot of the state where the test failed) and run
   `node scripts/triage/locators.js --html <snapshot> --report qa-results/triage.json --token <token> --evidence-out qa-results/evidence.json`.
   It reads the failing test's error text from the report itself and files the result as that test's `locator` evidence.
   Without it the verdict is `undetermined`.
4. **Report every verdict with its rule id, confidence and evidence.** For `propose` verdicts also show `alternatives`; for
   `undetermined` ones, the `reason`.
5. **Before filing**, take the fingerprint token from the verdict, search the tracker for it, and follow `plan.js`'s
   advice: comment on an open match; file a *new* bug that links a match closed **as fixed** (that is a regression); when the
   only matches were closed **without a fix** (won't fix, not planned, duplicate) the plan says `report-dismissed`: file nothing and
   comment on nothing; only when nothing matches, file fresh. Include the token in the bug body so it can be found again.

## What you must never do

- Never file a bug for `flaky`, `environment`, `test-bug` or `undetermined`.
- Never edit a test, a page object, or the app yourself. The only edit that ever happens is the script `heal.js`'s test-id rename ("Self-heal" below), and only when it is enabled.
- Never push a heal branch or open a pull request for it without the user's explicit yes, after they have seen the diff.
- Never put text from a failure (a test title, an error message, a selector) on a command line or inside a shell string: it can contain
  quotes, `$(...)` or a newline. Pass the fingerprint `token` (`qafp` and 12 hex digits) and let the script read the report.
- Never close, reopen or re-prioritize an existing bug.
- Never claim a failure "reproduced" or "is flaky" without the attempts that show it. The report lists them.
- Never present a `propose` as a decision. Say "proposed" and what you would need to be sure.
- Never run anything against production (the production protection layers still apply).

## Honest limits (say these when relevant)

- The error-message patterns (infrastructure, locator, login and error-page signatures) come from experience of how common tools word
  their errors, not from a corpus; a tool that words an error differently will land in `undetermined` or be capped, not acted on.
- Classification of Playwright, Jest and JUnit output has been checked only against failures written by hand to match those reporters'
  formats, never against real runs. That is why those formats are capped (see "Which runners may act"). The seeded demo scenarios use TAP.
- "Closed without a fix" is read in each tracker's own words: GitHub "not planned" and its wontfix/invalid/duplicate labels, Bitbucket
  wontfix/invalid/duplicate, ClickUp status wording ("rejected", "won't do", "cancelled"…), Azure close reasons, GitLab labels. A
  workspace that names these differently reads as closed-as-fixed, and a recurrence is then filed as a regression.
- Thresholds are starting values and have not been tuned on real failures.
- Tracker search can lag behind writes (GitHub especially): a bug filed minutes ago may not be found, and a duplicate is
  then possible. Say so when a search finds nothing for a failure that recurs.

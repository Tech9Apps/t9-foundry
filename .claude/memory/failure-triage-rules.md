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
| `test-bug` | the test is wrong (stale selector, crashed test code) | **proposed only**: name the cause and the candidate fix. Nothing is edited. |
| `flaky` | passes and fails with no change | **never filed.** Reported with its flip counts. |
| `environment` | the system under test or its infrastructure was down or unreachable | **never filed.** Reported, with the advice to re-run when the environment is healthy. |
| `undetermined` | no rule has enough evidence | **proposed only**, with what evidence would settle it |

Only `product-bug` ever becomes a bug report. Filing a bug for a flaky test, a stale selector or an outage is the
failure this whole file exists to prevent.

## Confidence and acting

Every verdict has a confidence from the table below and an `action`:

- `act` — confidence **≥ the threshold** (default **0.8**, `--threshold` to change it)
- `propose` — anything lower. Present it to the human with the evidence; do not act.

A low-confidence verdict is a proposal **regardless of any autonomy setting**. Never round a confidence up.

## What the classifier reads

Reporters put a one-line summary in a failure's `message` and the diagnosis in `details`: Playwright's `Received: <element(s) not found>`,
the status code a request got back, the locator it was waiting for. Every signal below reads **both**. (Reading only the summary
mistook stale selectors, expired sessions, 503s and 404 pages for failed assertions, and filed them as product bugs.) Two more kinds of
failure are **not** evidence about the app and never become a `product-bug` on their own:

- a **login / authorization** signal: a 401 or 403 where something else was expected, or a redirect to a login page. An expired test account
  looks exactly like a permission regression, so the verdict is `undetermined` ("check the test credentials first");
- an **error page**: the page or API answered 404, 500 or "Something went wrong". A wrong base URL, a dead route and a real regression look
  the same from the test alone, so the verdict is `undetermined`.

Two things about runner wording that matter because TAP (node:test) is the format that may act:

- node prints a failed status check as `503 !== 200` (strict, or `==` for the loose `assert.equal`), not as Playwright's "Received: 503". The
  signals read that form too, in either order, so the 5xx / 401 / 403 / 404 rules above hold for node output as well.
- node reports **every** error thrown in a test body with the same `failureType`, a failed assertion and a `TypeError: fetch failed` alike. Only
  the error's own code (`ERR_ASSERTION`) says it was an assertion, so only that is "an assertion about the app"; a thrown network error is an
  environment problem and any other thrown error is a crash.

## Which runners may act

How well the rules classify a failure is only known for the formats they have been checked on. `product-bug` and `test-bug` are the two
classes that can file a bug or edit a test, so for a runner format that has not been **verified against real failure output** those
verdicts are held at `propose` however confident the rule is: the verdict carries `cap: unverified-format` and its evidence says why.
Formats trusted by default: **tap**. Widen the list with `--trusted-formats` only after checking a format on real failures.
Environment, flaky and undetermined verdicts are never capped (acting on them only means reporting them).

## The rules

First match wins. Matching rules that lose are kept as `alternatives` — read them, and show them to the human when the
verdict is a proposal.

| Id | Class | Confidence | When it applies |
|---|---|---|---|
| ENV-1 | environment | 0.95 | preflight reported the environment as not ready |
| ENV-2 | environment | 0.90 | **every** failing attempt carries an infrastructure error: `ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, `EAI_AGAIN`, `getaddrinfo`, `net::ERR_CONNECTION*` / `NAME_NOT_RESOLVED`, `ERR_CERT*` / `ERR_SSL*` / `ERR_EMPTY_RESPONSE`, a certificate that is expired or self-signed, `502/503/504` (including "Received: 503" and node's `503 !== 200`), a request that never got an answer (`fetch failed`, `Failed to fetch`, `NetworkError when attempting to fetch`, `Load failed`), `Bad Gateway`, `Service Unavailable`, `socket hang up`. A bare "timeout exceeded" is **not** one — it is ambiguous |
| FLK-1 | flaky | 0.90 / 0.85 | the test both failed and passed with no change (0.90), or the runner's own retry made it pass (0.85) |
| TST-1 | test-bug | 0.85 | a locator was not found in every failing attempt, the DOM evidence shows that test-id is **not** on the page, and **exactly one** element resembles it |
| TST-2 | test-bug | 0.80 | the test **crashed** (not an assertion) with a `TypeError` / `ReferenceError` / `SyntaxError` / missing module whose first stack frame is in a test file |
| ENV-3 | environment | 0.60 | at least 3 tests and at least half the run failed, and one error signature accounts for at least 80% of those failures — an outage, or one real suite-wide regression; the tests alone cannot say which |
| PRD-1 | product-bug | 0.85 | failed in **every** attempt (≥ 2) with the same assertion, and the test traces to a documented manual case |
| PRD-2 | product-bug | 0.75 | as PRD-1, but the test is not traceable to a manual case |
| PRD-3 | product-bug | 0.60 | an assertion failed on a **single** attempt — no re-run was done, so a flake cannot be ruled out |
| UND-1 | undetermined | 0.50 / 0.40 / 0.30 | none of the above has enough evidence (a locator error with no or ambiguous DOM evidence, consistent timeouts, different errors every time) |

Why this order: environment signatures and pass/fail flips are the cheapest and most reliable evidence, so they come
first. "The app is wrong" is the weakest positive claim, so it comes last and is capped lower when it cannot be tied to a
documented expectation.

## What you must do

1. **Run the preflight first** and pass its result (`--preflight ok|failed`). A failed preflight makes every failure an
   environment failure; do not triage past it.
2. **Re-run every failing spec** (default 2 re-runs, into `qa-results/rerun-<n>/`) before classifying — it is what
   separates PRD-1 (0.85) from PRD-3 (0.60) and what exposes flakes. Skip re-runs only for ENV-1, and say you did.
3. **For a locator-not-found failure, capture the page** (a DOM snapshot of the state where the test failed) and run
   `node scripts/triage/locators.js --html <snapshot> --report qa-results/triage.json --token <token> --evidence-out qa-results/evidence.json`.
   It reads the failing test's error text from the report itself and files the result as that test's `locator` evidence.
   Without it the verdict is `undetermined`.
4. **Report every verdict with its rule id, confidence and evidence.** For `propose` verdicts also show `alternatives`.
5. **Before filing**, take the fingerprint token from the verdict, search the tracker for it, and follow `plan.js`'s
   advice: comment on an open match; file a *new* bug that links a match closed **as fixed** (that is a regression); when the
   only matches were closed **without a fix** (won't fix, not planned, duplicate) the plan says `report-dismissed`: file nothing and
   comment on nothing; when both kinds match, the **later** report is the team's last word (a regression report that was then dismissed
   is not filed again), and if the tracker gave no dates the plan stays with `file-regression` and says to check; only when nothing matches, file fresh. Include the token in the bug body so it can be found again.

## What you must never do

- Never file a bug for `flaky`, `environment`, `test-bug` or `undetermined`.
- Never edit a test, a page object, or the app as part of triage. (Self-healing is a separate, not yet enabled capability.)
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
  wontfix/invalid/duplicate, ClickUp status wording ("rejected", "won't do", "not planned", "out of scope", "cancelled"…), Azure close reasons, GitLab labels. A
  workspace that names these differently reads as closed-as-fixed, and a recurrence is then filed as a regression.
- Thresholds are starting values and have not been tuned on real failures.
- Tracker search can lag behind writes (GitHub especially): a bug filed minutes ago may not be found, and a duplicate is
  then possible. Say so when a search finds nothing for a failure that recurs.

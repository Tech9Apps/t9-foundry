# Run and Triage

Run the configured test suite against the **test environment**, work out *why* each failure happened, and act on what
the evidence supports: file or comment on bugs for real product defects, and only report everything else.

`$ARGUMENTS` is optional: one or more spec files to run instead of the whole suite (e.g. `/run-and-triage login.spec.ts`).

The verdicts come from code, not from you. `scripts/triage/orchestrate.js` runs the suite, re-runs the failing specs,
classifies each failure by the rules in `.claude/memory/failure-triage-rules.md`, and checks the tracker for existing
reports. You gather evidence where it asks for it, run it, and act on its output. **You never re-label a verdict and
never promote a `propose` to an action.**

## Before you start — read these, they are binding

1. `.claude/memory/ai-usage-rules.md` (honesty rules, §5, apply in full) and `.claude/memory/failure-triage-rules.md`.
2. Do steps 1–3 of `.claude/skills/run-tests.md` **exactly**: read `qa-config.json` (stop if it is missing or
   `testFramework.type` is unset), run the production guard (stop if `testEnvironmentBaseUrl` matches a production
   pattern), and confirm the target environment with the engineer before running anything.

**PRODUCTION PROHIBITION — ABSOLUTE.** Everything here runs against `environments.testEnvironmentBaseUrl` only.

## 1. Preflight

```bash
bash scripts/preflight.sh
```

Exit **0** → `--preflight ok`. Exit **1** → `--preflight failed`: the environment is not ready, so every failure will be
an environment failure; the orchestrator skips the re-runs. Tell the user what preflight reported.

## 2. Run, re-run, classify, plan — one command

```bash
node scripts/triage/orchestrate.js --framework <testFramework.type> --preflight <ok|failed> --run-id <run-id> --out qa-results
```

Add `--test-dir <testFramework.testDir>` and `--config-file <testFramework.configPath>` when those are set, and one
`--spec <file>` per file in `$ARGUMENTS`. Generate `<run-id>` **once** for this run (a UTC timestamp such as
`20261008T181500Z`) and reuse it if you have to run anything again: it is what makes retries safe. Re-runs default to 2
(`--reruns`, 0–5); more re-runs cost more and give better signal.

Verdicts for runner formats that have not been verified on real failures (everything except TAP, by default) can never `act` on a
`product-bug` or `test-bug`: they are held at `propose` and marked `cap: "unverified-format"`. Do not pass `--trusted-formats`
to widen that unless the user tells you a format has been verified; it is their call, not yours.

It prints one JSON document and writes `qa-results/triage.json`, `plan.json` and `flaky.json`. Exit codes:

| Exit | Meaning | You |
|---|---|---|
| 0, `status: "green"` | every test passed | report that, with the totals. Done. |
| 0, `status: "triaged"` | some tests failed or flaked | go to step 3 |
| 3 | **no trustworthy result**: the runner could not start, hung, wrote nothing, listed zero tests, or its exit code contradicted its report | report `error.message` and `warnings` exactly. **Do not call it a pass, and do not guess verdicts.** |
| 2 | bad invocation | fix the arguments |

`warnings` can mean the tracker could not be searched (credentials, outage). Say so plainly: it means an existing report
for a failure could not be ruled out, so filing may duplicate.

## 3. Evidence the orchestrator asked for

Any verdict whose `evidence` says to capture the page (a locator was not found and no snapshot was supplied) is
`undetermined` until you provide it. For each such failure take its `token` from `qa-results/triage.json` (`qafp` plus 12 hex
digits). It is the **only** thing from the failure that goes on a command line: a test title or an error message can contain a quote
or `$(...)`.

1. Capture the page **in the state where the test failed**, against the test environment, to
   `qa-results/snapshots/<token>.html` (the failure's screenshot/trace in `test-results/` shows the state; a short script
   that navigates there and writes the page's HTML is enough). Never capture from production.
2. Run:

   ```bash
   node scripts/triage/locators.js --html qa-results/snapshots/<token>.html --report qa-results/triage.json --token <token> --evidence-out qa-results/evidence.json
   ```

   It finds that failure in the report, reads its error text itself, and merges the result into `qa-results/evidence.json` under the
   right test. You do not copy a selector or message anywhere, and you do not write the evidence file.

Then re-classify and re-plan from the runs already on disk (no need to run the suite again):

```bash
node scripts/triage/classify.js --run qa-results/main/result.json --rerun qa-results/rerun-1/result.json --rerun qa-results/rerun-2/result.json --preflight <ok|failed> --evidence qa-results/evidence.json --out qa-results/triage.json
node scripts/triage/plan.js --report qa-results/triage.json --run-id <run-id> --out qa-results/plan.json --flaky-out qa-results/flaky.json
```

(Pass one `--rerun` per `rerun-<k>` directory that exists.)

## 4. Act on each step in `plan.json`

| `step` | What it means | What you do |
|---|---|---|
| `file-bug` | a real product bug, nothing on file | delegate to the **Bug-reporter** agent (below) |
| `file-regression` | the only matching report is **closed**: the defect came back | delegate to **Bug-reporter**; the new bug must link the closed one (`regressionOf`) |
| `comment-existing` | an **open** report already covers it | show the user the comment (`commentInput.body`) and the existing report; **only on their yes**, run `node scripts/tracker/cli.js comment --input-file qa-results/comments/<token>.json` (the action's `commentInputFile`: the plan already wrote it, so you write nothing) |
| `report-dismissed` | the only report with this fingerprint was closed **without a fix** (won't fix, not planned, duplicate…) | **report only**: say which report and how it was closed. File nothing and comment on nothing: this is not a regression of a fix. If the user thinks that decision was wrong, they re-open it themselves. |
| `duplicate-in-run` | the same defect as another failure in this run | nothing: it is covered by `duplicateOf` |
| `propose-test-fix` | the test is stale or crashed (a test-bug) | **report only**: name the cause and the candidate selector. **Edit nothing** — self-healing is not enabled. |
| `report-flaky` | passes and fails with no change | **report only**, with the attempts. Never file it. |
| `report-environment` | the environment was down or unreachable | **report only**, with the advice to re-run when it is healthy. Never file it. |
| `propose` | not confident enough to act, **or** held back because the runner format is unverified (`cap`) | **report only**: show the verdict, its confidence, its `alternatives` (or the `cap` reason), and what evidence would settle it |

Only `product-bug` verdicts at or above the confidence threshold ever reach `file-bug`, `file-regression` or
`comment-existing`. Nothing is filed, commented or edited without the human review gate.

### Handing a bug to Bug-reporter

Use the **Agent tool** to invoke `Bug-reporter` with a prompt that gives it everything the plan found: the failing test
and spec file, the error message, the verdict (rule, confidence, evidence, attempts), and — verbatim — the line
`qa-harness-fingerprint: <token>` that **must be included in the bug body** (it is how the next run finds this bug). Give
it the plan's `idempotencyKey`, and for `file-regression` the closed report's id and url to link. It runs the
`/file-bug` pipeline, including its human review gate; relay any approval request to the user and wait.

## 5. Report

Tell the user, in this order:

1. **Totals**: tests, passed, failed, skipped, flaky, and how many runs (1 + re-runs) the verdicts rest on.
2. **Every verdict**: test, class, rule id, confidence, `act` or `propose`, and the evidence in one line. For proposals
   include the alternatives.
3. **What you did**: bugs filed or commented on (ids/urls), and what was only reported.
4. **What you could not check**: tracker search failures, missing snapshots, anything below the threshold. Never
   present a proposal as a decision.

Checkpoint convention: include each line verbatim in your final message, in order:
1. After the main run and triage: `**✅ Run executed and failures triaged**`
2. After the plan is read and acted on (or reported): `**✅ Triage actions completed or proposed**`

# Structured test results

The harness used to learn how a run went by reading the console summary ("5 passed, 1 failed") — different for every
framework, and silently wrong the day a reporter changes its wording. Now it asks the framework for a **report**
(JUnit XML, TAP or JSON), reads that, and works from one normalized shape.

```bash
node scripts/results/run.js --framework playwright --spec login.spec.ts --headed   # run + report + normalize
node scripts/results/normalize.js path/to/report.xml                                # just normalize an existing report
```

## What you get back

One JSON document ([`schemas/run-result.schema.json`](../schemas/run-result.schema.json)), also written to
`qa-results/result.json`:

```jsonc
{
  "ok": false,                      // false if anything failed OR the exit code and report disagree
  "exitCode": 1,
  "command": "npx playwright test login.spec.ts --headed --reporter=list,json",
  "data": {
    "format": "playwright-json",
    "totals": { "total": 5, "passed": 2, "failed": 2, "skipped": 1, "flaky": 1 },
    "durationMs": 36000,
    "tests": [{
      "name": "DEMO-101/TC-002: rejects an expired code",
      "status": "failed",           // passed | failed | skipped
      "ticket": "DEMO-101", "caseId": "TC-002",
      "error": { "kind": "failure", "message": "…", "details": "stack / full output" },
      "file": "checkout.spec.ts", "line": 22, "durationMs": 1500
    }]
  }
}
```

- **`ticket` / `caseId`** are read from the test name (`DEMO-101/TC-002: …`, or `TC-002`, or pytest's `test_TC_002_…`),
  which is how a failing test is tied back to the manual test case and the ticket it came from.
- **`error.kind`** — `failure` (an assertion), `error` (the test crashed or its setup did) or `timeout`.
- **`flaky: true`** — it failed, then passed on a retry. Counted as passed, but flagged. Only formats that record
  retries can say so (Playwright JSON, JUnit `<flakyFailure>`); Jest and TAP cannot.

## Exit codes of `run.js`

| Code | Meaning |
|---:|---|
| 0 | the runner exited 0 **and** every test in its report passed |
| 1 | tests failed (the failures are in `data`) |
| 2 | bad invocation (reason on stderr) |
| 3 | **no trustworthy report** — the runner could not start, was killed at `--timeout-ms`, wrote nothing, listed **zero tests**, **skipped every test** (nothing was verified; pass `--allow-all-skipped` if that is intended), or its exit code contradicts its report (e.g. exit 137 but no failures listed = it crashed after a partial report) |

Exit 3 exists because "I could not tell" must never read as "all green". A stale report from a previous run cannot stand
in either: `run.js` clears its own `qa-results/raw/` **and deletes the previous `qa-results/result.json`** before every
run (a `--dry-run` only previews and deletes nothing), so after any run that ends in exit 3 there is no `result.json`
to be mistaken for this run's.

The runner is started in its own process group. On a timeout, and when `run.js` is stopped (Ctrl-C, SIGTERM, SIGHUP),
the whole group is killed: `npx playwright test` is a launcher, and killing only it would leave the workers and browsers
running into a folder the next run clears.

Two guards protect the caller, because `--out` and the spec/dir/config arguments are caller-controlled:

- **It only clears a directory it can show is its own.** `raw/` is cleared when it is empty, holds only test reports, or
  carries the `.qa-results-raw` marker that `run.js` writes when it creates it. Any other file in there (`precious.txt`)
  makes it refuse with exit 2 instead of deleting somebody's files — choose another `--out`.
- **`--spec`, `--test-dir` and `--config-file` — and `testFramework.testDir` / `.configPath` in `qa-config.json` — cannot smuggle an option to the test runner.** A value that starts with
  `-` (a spec of `--import=./x.js` would make node load that file) is exit 2; write `./-name` for a path that really
  starts with a dash.

## Frameworks

`run.js --dry-run` prints the exact command for any of these without running anything.

| `--framework` | Runs | Report | Needs |
|---|---|---|---|
| `playwright` | `npx playwright test … --reporter=list,json` | Playwright JSON (`PLAYWRIGHT_JSON_OUTPUT_NAME`) | — (overrides the reporter in your config for this run) |
| `cypress` | `npx cypress run … --reporter junit` | JUnit, one file per spec | — (the console shows little: Cypress's own reporter is replaced) |
| `pytest` | `python -m pytest … -v --junitxml=…` | JUnit | — |
| `rspec` | `bundle exec rspec … --format RspecJunitFormatter --out …` | JUnit | the `rspec_junit_formatter` gem |
| `jest` | `npx jest … --verbose --json --outputFile=…` | Jest JSON | — |
| `webdriverio` | `npx wdio <config> [--spec …]` | JUnit, one file per worker (merged) | `@wdio/junit-reporter`, configured: `reporters: ['spec', ['junit', { outputDir: process.env.QA_RESULTS_DIR }]]` |
| `node` | `node --test --test-reporter=tap …` | TAP (with file and line, which re-running only the failing specs needs) | Node 22 (verified on 22.17; it is what the demo app uses) |
| `selenium`, `other` | *no recipe* | — | run your suite as you normally do, then `normalize.js` its JUnit/TAP/JSON report |

Defaults for `--framework`, `--test-dir` and `--config-file` come from `testFramework` in `qa-config.json`. Every
argument is passed to the runner as its own array element — there is no shell, so a spec path containing `;` is just a
strange file name.

## How well is this verified?

| | |
|---|---|
| The parsers and normalizer | Tested against **real** `node --test` output (TAP and JUnit, 22 tests, 2 planted failures) against **real** Jest 30.5.2 and Playwright 1.65.0 reports for a small demo app (`tests/fixtures/results/real/`), and against hand-written fixtures for pytest, Cypress, WebdriverIO, RSpec and the other Playwright/Jest shapes. The hand-written ones follow each tool's documented report shape but were **not captured from a live run** — each says so in `tests/fixtures/results/README.md`. |
| The orchestration (`run.js`) | Tested with a fake runner for every failure mode (crash after a partial report, hang, nothing written, stale report, missing binary) **and** with real `node --test` runs. |
| The recipes for playwright, cypress, pytest, rspec, jest, webdriverio | The command lines come from each tool's documentation and are pinned by tests, but **have not been run against the real tool**. The `node` recipe has — it caught a real bug (reporter flags placed after a file name are silently ignored). Run `run.js` once per framework you use, and if a flag is off the failure is loud: exit 3 with the framework's own output on stderr. |

Mutation checks (breaking the code on purpose and confirming a test fails) cover the parsers (20 mutants) and the
runner (12); the ones that survived the first round each exposed a missing test, now added.

## Known limits

- **A suite whose own hook throws is invisible to `run.js --framework node`.** For a `describe` whose `after` hook throws and
  whose tests pass, Node 22.17 itself exits 0 and every reporter (JUnit, spec and TAP's own summary) counts it as a pass;
  only the TAP stream carries the `not ok … failureType: 'hookFailed'` line, and the node recipe reads JUnit. The TAP parser
  does report such a suite as a failed test (use `normalize.js` on a TAP file, or run `node --test --test-reporter=tap`
  yourself), but through `run.js` there is nothing in the report or the exit code to notice.
- **A directory of reports** (WebdriverIO, Cypress) is read file by file. A file that is not a test report at all (a
  `package.json`) is left out and listed under `warnings`; a file that is a report but cannot be parsed, or is empty,
  fails the run with that file's name rather than being dropped. That includes a `.json` that does not parse at all (a runner killed
  mid-write leaves one): it is a damaged report, not "some other file". The cost is that a config with comments (JSONC) sitting in the
  report directory now fails the run too, loudly, which is the safe way round; keep other files out of the report directory.
- JUnit from `node --test` drops the newline inside the `message` attribute, so messages read run-together
  ("…rejected200 !== 400"); the full text is in `error.details`.
- Tests that fail to *load* (a syntax error, a bad import) are reported by Jest JSON as a failed file and appear as one
  failed test named after the file. Other formats report them in their own way — or not at all, which is why a zero-test
  report is an error.
- Retries are only visible in formats that record them (see `flaky` above).

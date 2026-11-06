# Real reporter output

Raw reports written by the real tools, for a tiny demo app whose failures have **known causes**, so triage can be checked against the right answer.

| File | Tool | How it was produced |
|---|---|---|
| `jest-30.5.2.results.json` | Jest 30.5.2 | `jest --json` (what `scripts/results/run.js` runs) against `demo-app/tests/jest`, 20 tests, 7 failing |
| `playwright-1.65.0.results.json` | @playwright/test 1.65.0 | the JSON reporter against `demo-app/tests/pw`: API tests (no browser) and UI tests driving an installed Google Chrome, 23 tests, 9 failing |

| `playwright-1.65.0.results.junit.xml` | Playwright 1.65.0 | its built-in JUnit reporter (`--reporter=junit`) against the same Playwright tests |
| `jest-junit-17.0.0.results.xml` | jest-junit 17.0.0 (Jest 30.5.2) | `jest --reporters=jest-junit` against the same Jest tests |

Environment: macOS (arm64), Node 22.17, npm 11, Chrome via `channel: 'chrome'`. The only change to the captured files is that the absolute path of the work folder was rewritten to `/work/demo-app`.

## The demo app and what each failure really is

`demo-app/server.js` is a 20-line HTTP server with deliberate behaviour. Test ids are `DEMO-1/TC-00n` (API) and `DEMO-2/TC-00n` (UI).

| Test | What happens | Right classification |
|---|---|---|
| `DEMO-1/TC-002` | the app returns total 10, the test expects 11 | product-bug |
| `DEMO-1/TC-003` | the service answers 503 | environment |
| `DEMO-1/TC-004` | the endpoint answers 401 | undetermined |
| `DEMO-1/TC-005` | the endpoint answers 404 | undetermined |
| `DEMO-1/TC-006` | nothing is listening on the port (`fetch failed` / ECONNREFUSED) | environment |
| `DEMO-1/TC-007` | the test calls a helper that does not exist | test-bug |
| `DEMO-1/TC-008` | the endpoint takes 4 s, the test allows 1.5 s | undetermined (a timeout is never a product bug) |
| `DEMO-2/TC-001` | the test looks for `coupon-apply-btn`, the page has `coupon-apply` | test-bug (with a DOM snapshot; undetermined without) |
| `DEMO-2/TC-002` | the button says "Apply", the test expects "Apply now" | product-bug |

`tests/triage/real-output.test.js` runs these reports through the real parser and classifier and checks every row, for each of the four report files.

The two JUnit files differ from the JSON ones in ways worth knowing: Playwright's JUnit puts an assertion in `<failure>` and a thrown error (including `TimeoutError`) in `<error>`; jest-junit prefixes every name with the describe block (`api DEMO-1/TC-002: …`) and puts every failure, timeouts included, in a bare `<failure>`. All 16 failing tests across the two files are classified correctly.

## What this does and does not show

The Jest and Playwright JSON reports found two mistakes the hand-written fixtures could not (the JUnit reports found none) (a Playwright action timeout read as an assertion about the app; a found element with the wrong text read as a stale selector). It is **one small app, two tools, one version each**: enough to catch wording the real tools use, not enough to say a format is safe to act on for every project. The default therefore stays "TAP only"; `triage.trustedFormats` is the project's call.

## Capturing again

Install `jest` and `@playwright/test` in a throwaway folder next to a copy of `demo-app/`, start `node server.js`, then run
`node scripts/triage/orchestrate.js --framework jest|playwright --cwd <folder> --out <out> --no-plan --trusted-formats jest-json,playwright-json`
(the raw reports are in `<out>/main/raw/`). Playwright's UI tests need Chrome (or `npx playwright install chromium`).

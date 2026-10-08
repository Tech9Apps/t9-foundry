# Execute Playwright Tests

You are given an argument: **$ARGUMENTS** — a spec file name or path.

**If `$ARGUMENTS` is empty, stop immediately and tell the user:**
> "You have not defined any spec file to run. Usage:
> `/run-spec-tests <spec-file>` — e.g. `/run-spec-tests login.spec.ts`"
**Do not proceed.**

## Framework Check

Read `testFramework.type` from `qa-config.json`.
- **Unset**: stop and tell the user to run `/setup-e2e-framework` first.
- **Not `playwright`**: stop and tell the user this command only runs Playwright specs directly; point them to `/run-tests`, which runs the configured test suite for any supported framework (Cypress/pytest/RSpec/Selenium/WebDriverIO/Jest).

## Find the Spec File

Resolve `$ARGUMENTS` to a concrete path directly:
```bash
find tests/ -iname "*$ARGUMENTS*" --include="*.spec.ts" 2>/dev/null || find tests/ -iname "*$ARGUMENTS*"
```
If `$ARGUMENTS` already looks like a path (contains `/`), use it as-is provided the file exists.

- **No match found:** stop immediately and tell the user:
  > "This spec file (`$ARGUMENTS`) is not available in the folder structure. Check the file name/path and try again — e.g. `/run-spec-tests login.spec.ts`."
  Do not proceed.
- **More than one match found:** list the candidates and ask the user to disambiguate — do not guess.

## Execute Tests

Run the spec through the harness runner. It runs Playwright in headed mode (so the user can watch), makes it write a
JSON report, and normalizes that report — so you read exact counts and failures from data instead of scraping console
output:

```bash
node scripts/results/run.js --framework playwright --spec <path-to-spec-file> --headed
```

Playwright's own list output streams to the terminal as it runs. When it finishes, stdout is one JSON document and
`qa-results/result.json` holds the same thing. Exit codes: **0** every test passed · **1** some failed · **2** bad
invocation · **3** no trustworthy report (Playwright could not start, was killed, wrote nothing, or its exit code
contradicts its report — read `error.message` or `warnings`; never report that as a pass).

### Handle Failures (max 3 retries):

For each test in `data.tests` with `status: "failed"`, `error.message` and `error.details` say what failed, and `error.kind`
says whether it was an assertion (`failure`), a crash (`error`) or a `timeout`:

1. **Read the failure screenshot** from `test-results/` to understand what the browser was showing at the time of failure
2. **Selector/locator issues** — fix selectors in the page object (`pages/<feature>.page.ts`), re-run
3. **Timing/load issues** — increase timeouts or add appropriate `waitFor` calls in the agent, re-run
4. **Test logic errors** — fix the spec file, re-run
5. **Element intercepted by overlay** — use `{ force: true }` on hover/click, or dismiss the overlay first, re-run
6. After 3 failed retries, proceed with the failure details

Re-run with the same command. A test that passes only after Playwright's own retries comes back `flaky: true` — report
it as passed but flag it; do not fix or hide it silently.

### Capture Results:
Read them from `data` in the JSON (or `qa-results/result.json`):
- `totals.total`, `totals.passed`, `totals.failed`, `totals.skipped`, and `totals.flaky` if present
- each failure's `name`, `error.message`, `error.kind` (and `ticket` / `caseId` when the test name carries them)
- `durationMs`

## Output

Print:
- Test execution results (passed/failed/skipped, and flaky if any)
- Execution time
- Spec file path used

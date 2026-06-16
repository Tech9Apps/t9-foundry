# run-tests

Execute the configured test suite against the staging environment and report a structured
pass/fail summary. Enforces the production guard before running any command.

## When to invoke

Trigger phrases: "run tests", "run my tests", "execute tests", "run the test suite",
"run e2e", "run e2e tests", "run playwright", "run cypress", "run pytest",
"execute the test suite", "/run-tests"

## Steps

1. **Read config**
   Run `jq . qa-config.json`. If the file is missing, stop and direct to `/init`.

   If `testFramework.type` is not set, stop:
   "No test framework is configured. Run `/setup-e2e-framework` to scaffold one first."

   Read the following values:
   - `testFramework.type`
   - `testFramework.testDir`
   - `testFramework.configPath`
   - `environments.testEnvironmentBaseUrl`
   - `productionProtection.prodUrlPatterns`
   - `project.name`

2. **Production guard — REQUIRED BEFORE ANY COMMAND**
   Check `testEnvironmentBaseUrl` against every entry in `prodUrlPatterns`.
   If any pattern matches: **STOP immediately**. Report:
   "BLOCKED: testEnvironmentBaseUrl matches a production pattern. Tests must not run
   against production. Update the URL with `/reconfigure` or fix the pattern."
   Do not proceed.

3. **Confirm the target environment with the engineer**
   Display: "About to run {testFramework.type} tests against {testEnvironmentBaseUrl}."
   Ask for confirmation before executing. Wait for the engineer's go-ahead.

4. **Build and run the test command**

   Set the base URL as an environment variable before the command.
   Use `TEST_BASE_URL` as the variable name in the shell invocation; frameworks read it
   via their own config (see per-framework notes below). Never hardcode the URL in the
   command string itself.

   Per-framework commands (run from `testFramework.testDir` or the repo root):

   ### Playwright
   ```
   TEST_BASE_URL="{testEnvironmentBaseUrl}" npx playwright test
   ```
   Playwright picks up `TEST_BASE_URL` via `process.env` in `playwright.config.ts`.
   If `testFramework.configPath` is set, add `--config {configPath}`.
   Add `--reporter=list` for readable per-test output.

   ### Cypress
   ```
   TEST_BASE_URL="{testEnvironmentBaseUrl}" npx cypress run
   ```
   Cypress reads the URL from `process.env.TEST_BASE_URL` in its config or support file.
   If a `testFramework.configPath` is set, add `--config-file {configPath}`.

   ### pytest
   ```
   TEST_BASE_URL="{testEnvironmentBaseUrl}" python -m pytest {testFramework.testDir} -v
   ```

   ### RSpec
   ```
   TEST_BASE_URL="{testEnvironmentBaseUrl}" bundle exec rspec {testFramework.testDir}
   ```

   ### Jest
   ```
   TEST_BASE_URL="{testEnvironmentBaseUrl}" npx jest {testFramework.testDir} --verbose
   ```

   ### WebDriverIO
   ```
   TEST_BASE_URL="{testEnvironmentBaseUrl}" npx wdio {testFramework.configPath}
   ```

5. **Parse the output**
   Extract pass/fail/skip counts from the command output:
   - Playwright: look for `X passed`, `Y failed`, `Z skipped` in the summary line
   - Cypress: look for `X passing`, `Y failing` in the run summary
   - pytest: look for `X passed`, `Y failed`, `Z skipped` in the final line
   - RSpec: look for `X examples, Y failures, Z pending`
   - Jest: look for `Tests: X passed, Y failed, Z skipped`

   Collect the name and first error line of each failing test.

6. **Present results**
   ```
   Test Run — {project.name}
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Environment:  {testEnvironmentBaseUrl}
   Framework:    {testFramework.type}

   Results:  ✓ {N} passed   ✗ {M} failed   — {S} skipped

   {If failures:}
   Failures:
     ✗ {test name}
       {first error line}
     ✗ {test name}
       {first error line}
   ```

7. **Suggest next steps**
   - All tests pass: "All tests passed. Run `/upload-tests TICKET-ID` to push test cases,
     or `/create-test-plan TICKET-ID` to continue with another ticket."
   - Some tests fail: "Would you like to see the full output for a specific failure, or
     help debugging any of these?"
   - All tests fail: Check if the staging environment is reachable first:
     `curl -s -o /dev/null -w "%{http_code}" {testEnvironmentBaseUrl}`
     If unreachable, report it and suggest running `/troubleshoot`.

# write-e2e-tests

Write complete, runnable e2e tests for a feature by combining ticket requirements, the test plan, and codebase analysis.

## When to invoke

Trigger phrases: "write e2e tests", "write end-to-end tests", "create Playwright tests", "write Cypress tests", "automate this feature", "write automation for", "generate e2e tests for", "automate the test cases"

## Arguments

- With ticket source configured: `TICKET-ID` (e.g., `/write-e2e-tests JIRA-123`)
- Without ticket source (`ticketSource.type = "none"`): the feature name used in `/create-test-plan` (e.g., `/write-e2e-tests user-checkout`)

Optional: `--cases TC-001,TC-003` — limit to specific test case IDs from the test cases file

## Steps

1. **Load all context**
   Read:
   - `qa-config.json` — framework, paths, environment URL
   - `{testPlansDir}/{ticket-id}-test-plan.md` — if exists
   - `{testCasesDir}/{ticket-id}-test-cases.json` — test cases marked `automatable: true`
   - `{analysisDir}/{ticket-id}-analysis.md` or `latest-analysis.md` — API routes, data models

   If test cases don't exist, run `/write-test-cases {ticket-id}` first.
   If framework is not configured, run `/setup-e2e-framework` first.

2. **Determine which test cases to automate**
   Filter `test-cases.json` to `automatable: true`. If `--cases` flag was provided, further filter to those IDs.
   Inform the engineer: "{count} automatable test cases found. Writing tests for: {list of titles}"

3. **Apply framework-specific patterns**

   ### Playwright
   - Import from `@playwright/test` and the project's test fixture
   - Use `test.describe('{feature name}', () => { ... })` grouping
   - Use `test.beforeEach` for auth and shared setup
   - Use the `DataFactory` to create test data; never hardcode test data values
   - Use Page Object classes for UI interactions; create a PO file if one doesn't exist
   - Import `BASE_URL` from the config, never hardcode

   ### Cypress
   - Use `describe('{feature name}', () => { ... })` grouping
   - Use `beforeEach` for shared setup
   - Use `cy.createTestUser()` custom command from the data factory
   - Use Page Object or App Actions patterns
   - `Cypress.env('BASE_URL')` — never hardcode URLs

   ### Pytest
   - Use fixtures for setup and teardown
   - Use `conftest.py` for shared fixtures
   - Factory functions in `conftest.py` or a dedicated `factories.py`

   ### Other frameworks
   Adapt the same principles: data factory for test data, teardown after tests, no hardcoded URLs or credentials.

4. **Write Page Object(s) if needed**
   For each distinct page/screen involved in the ticket, check if a page object already exists in `{testDir}/pages/` or `{testDir}/page-objects/`.
   If not, create a minimal Page Object with:
   - Selectors as private properties (prefer `data-testid` attributes; fall back to aria roles; avoid CSS classes)
   - Action methods that encapsulate interactions
   - Assertion helpers

5. **Write the test file**
   Save to: `{e2eTestsPath}/{ticket-id}.spec.ts` (or `.spec.js`, `.test.ts`, `.cy.ts` per framework convention)

   Each test must:
   - Start with data setup via DataFactory
   - Navigate to the feature under test
   - Execute the test scenario
   - Assert the expected outcome
   - NOT include explicit cleanup (handled by global teardown)

   **Absolute rules:**
   - No hardcoded URLs — use `process.env.BASE_URL` or the config loader
   - No hardcoded credentials — use `process.env.TEST_USER_EMAIL` etc.
   - No production URLs, production API keys, or production database strings anywhere
   - No `sleep` or arbitrary `wait` — use proper async waiting patterns

6. **Validate syntax without running**
   Run a dry-run check to confirm the test file is syntactically valid:
   - Playwright: `npx playwright test {file} --list`
   - Cypress: `npx cypress run --spec {file} --dry-run` (if supported) or just TypeScript compile check
   - Do NOT actually run the tests — only list/validate them

   If the dry-run shows errors, fix them before reporting completion.

7. **Report**
   Show: test file path, count of test cases written, count of page objects created/updated. Say: "Tests written. To run them against your staging environment: set `BASE_URL={testEnvironmentBaseUrl}` and run your test command. See `docs/e2e-patterns.md` for data management guidance."

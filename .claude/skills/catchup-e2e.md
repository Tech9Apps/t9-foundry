# catchup-e2e

Audit an existing project's e2e test coverage, identify gaps, and generate tests to fill them — without needing a ticket to drive the process. Works whether the project has no tests yet, a few tests, or a partially covered suite.

## When to invoke

Trigger phrases: "catch up on e2e", "audit e2e coverage", "find e2e gaps", "what's not tested", "fill coverage gaps", "analyze existing tests", "add tests without a ticket", "/catchup-e2e"

## Steps

### Step 1 — Read config and assess starting point

Run `jq . qa-config.json`. Stop if missing — direct to `/init`.

Read: `testFramework.type`, `testFramework.testDir`, `testFramework.configPath`, `codeRepository.localPath`, `environments.testEnvironmentBaseUrl`, `testOutput.e2eTestsPath`, `testOutput.testCasesDir`, `testOutput.analysisDir`.

Determine the starting mode based on current state:

**Mode A — No framework configured** (`testFramework.type` is not set):
Ask: "No e2e framework is configured yet. Should I:
1. **Scaffold one now** (runs `/setup-e2e-framework` then continues with full catchup)
2. **Generate a coverage plan only** — I'll analyze the codebase and show you what to test, without writing any test code yet"

- If (1): inline the `/setup-e2e-framework` steps to completion, then continue to Step 2.
- If (2): skip to Step 3, and in Steps 6–7 produce a prioritized test plan markdown file instead of actual test files.

**Mode B — Framework configured, no tests yet** (`testFramework.testDir` is set but contains zero test files matching the framework's pattern: `*.spec.ts`, `*.cy.ts`, `test_*.py`, `*_spec.rb`, `*.test.ts`):
Announce: "Your e2e framework is set up but no tests have been written yet. I'll analyze the live codebase and generate starter tests covering all your active features."
Skip Step 2 — proceed directly to Step 3.

**Mode C — Framework configured with existing tests** (testDir contains at least one matching test file):
Announce: "Found {N} test files. I'll audit your existing coverage and fill the gaps."
Proceed to Step 2.

---

### Step 2 — Inventory existing e2e tests (Mode C only)

Read every test file in `testFramework.testDir` recursively.

For each file, extract:
- **Test names** — `test('...')`, `it('...')`, `describe('...')`, `def test_...`, `it '...'`
- **Routes / URLs exercised** — arguments to `page.goto()`, `cy.visit()`, `browser.url()`, `driver.get()`
- **API endpoints called** — arguments to `page.request`, `cy.request()`, `requests.post()`, `fetch()`
- **Page Objects imported** — class names imported from `../pages/` or `../page-objects/`

Produce a summary table:
```
| Test file | # Tests | Routes / endpoints covered |
|-----------|---------|---------------------------|
| auth.spec.ts | 3 | /login, /logout, POST /api/auth/login |
| ...
```

---

### Step 3 — Analyze the codebase

Check for `{analysisDir}/latest-analysis.md`. If it exists and was created within the last 7 days, use it — announce "Using cached analysis from {date}."

Otherwise, run the three-pass analysis inline (same logic as `/analyze-codebase`, no ticket ID required):

**Pass A — Routes and API endpoints**
Scan controllers, routers, route files, and view templates. For each endpoint, record: HTTP method, path pattern, auth requirement, request/response shape.

**Pass B — Data models and entities**
Scan ORM models, schemas, migrations, and type definitions. Record key entities, their fields, relationships, and validation rules.

**Pass C — Risk areas**
Identify: recently modified files (from git log), complex conditional logic, known bug-prone patterns (raw SQL, unvalidated inputs, auth bypass risks), external service calls.

Save the analysis to `{analysisDir}/latest-analysis.md`.

---

### Step 4 — Build the coverage gap map (Modes B and C)

**Mode B:** Every route/feature found in Step 3 is a gap (0% starting coverage). Assign priority:
- **High** — auth flows, write operations (POST/PUT/DELETE), data-destructive actions, external payment/email calls, routes flagged as risk areas
- **Medium** — CRUD read paths, form validation, redirect logic, role-based access
- **Low** — static pages, health check endpoints, documentation routes

**Mode C:** Cross-reference the inventory (Step 2) against the analysis (Step 3):
- ✓ **Covered** — route/flow exercised by at least one existing test
- ✗ **Gap** — no test covers this route or feature
- ⚠ **Partial** — tests exist but only cover the happy path (no negative/boundary/auth cases)

Apply the same priority rules as Mode B to all gaps and partial entries.

---

### Step 5 — Present the coverage report

**Mode B (no tests yet):**
```
E2e Coverage Audit — {project.name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Framework:   {testFramework.type}
Test files:  0 (no tests written yet)
Environment: {testEnvironmentBaseUrl}

{N} routes/flows found — none have e2e tests yet.

Features to cover (by priority):
  HIGH    POST /api/auth/login — login flow
          DELETE /api/users/:id — account deletion
  MEDIUM  GET /api/users/:id — profile retrieval
          PUT /api/orders/:id — order update
  LOW     GET /api/health — health check
```

**Mode C (existing tests):**
```
E2e Coverage Audit — {project.name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Framework:   {testFramework.type}
Test files:  {N} files, {M} tests
Environment: {testEnvironmentBaseUrl}

Coverage Summary:
  ✓  {X} routes/flows fully covered
  ⚠  {Z} partially covered (happy path only)
  ✗  {Y} gaps ({H} high priority, {Med} medium, {L} low)

High-Priority Gaps:
  ✗ POST /api/auth/login — no invalid-credentials test
  ✗ DELETE /api/orders/:id — no unauthorized-access test
  ⚠ GET /api/users — happy path only, no pagination boundary test

Medium-Priority Gaps:
  ...
```

Then ask:
"Which gaps should I fill?
1. **All gaps** (recommended when starting from zero)
2. **High-priority only** (recommended when adding to an existing suite)
3. **Let me choose** — tell me which to skip"

Wait for the engineer's answer before proceeding.

---

### Step 6 — Generate test cases for selected gaps

For each selected gap or uncovered feature, derive test cases directly from the codebase analysis — no ticket required:

- **Uncovered route:** generate happy path + at least one negative case (invalid input, missing auth, wrong role)
- **Partial coverage (happy path only):** generate the missing negative and/or boundary cases
- **Auth-gated route with no auth test:** generate an unauthenticated access test (expect 401/redirect)
- **Data-destructive route:** generate a confirmation that the operation is reversible or permanent

Format identically to `/write-test-cases` JSON output:
```json
{
  "id": "GAP-001",
  "title": "POST /api/auth/login returns 401 for wrong password",
  "type": "negative",
  "priority": "high",
  "preconditions": "A test user account exists in staging",
  "steps": [
    { "step": 1, "action": "POST /api/auth/login with correct email and wrong password", "expectedResult": "Response status 401" }
  ],
  "testData": { "email": "{test_user.email}", "password": "{invalid_password}" },
  "automatable": true,
  "source": "coverage-gap"
}
```

Save all generated test cases to `{testCasesDir}/catchup-test-cases.json`.

For Mode A / plan-only path: save a human-readable markdown version to `{testCasesDir}/catchup-test-plan.md` and stop here — do not write test files.

---

### Step 7 — Write the e2e tests

For each selected gap, generate test code using the same framework-specific patterns as `/write-e2e-tests`:

**Playwright:**
- Import `test` and `expect` from `../fixtures/test-data.fixture`
- Use `test.describe` blocks grouped by feature area
- Use DataFactory fixtures for test data; Page Objects for all UI interactions
- Check `pages/` first — only create a new Page Object if the page doesn't already have one

**Cypress:**
- `describe`/`it` blocks; `cy.visit()` for navigation; `cy.request()` for API assertions
- Use existing custom commands from `support/commands.ts`

**pytest / Selenium:**
- `def test_` functions; use `base_url`, `browser`, and `test_user` fixtures from conftest
- Import from existing `support/` helpers before creating new ones

**RSpec:**
- `describe`/`context`/`it` blocks; use existing `spec/support` helpers

**Rules (apply to all frameworks):**
- No hardcoded URLs or credentials — read from `process.env.*` or fixtures
- Never duplicate a test that already exists — check the inventory from Step 2
- Group new tests by feature area, not by gap ID (e.g., `auth.spec.ts`, `orders.spec.ts`)
- All test data through DataFactory; teardown is automatic

Write files to `{e2eTestsPath}/`. After writing each file, validate syntax:
- Playwright: `npx playwright test {file} --list`
- Cypress: `npx cypress run --spec {file} --headless` (dry-run equivalent)
- pytest: `python -m pytest {file} --collect-only`
- RSpec: `bundle exec rspec {file} --dry-run`

---

### Step 8 — Summary

```
Catchup Complete — {project.name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Test cases generated:  {N} (saved to {testCasesDir}/catchup-test-cases.json)
Test files written:    {M} files in {e2eTestsPath}/
New Page Objects:      {K} (list filenames if any were created)
Gaps remaining:        {R} skipped (low priority or engineer excluded)

Next steps:
  /run-tests          — execute the new suite against {testEnvironmentBaseUrl}
  /setup-ci           — wire tests into your CI pipeline
  /catchup-e2e        — run again after fixes to check remaining gaps
```

If Mode A / plan-only was chosen:
```
Coverage Plan Complete — {project.name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Test plan saved: {testCasesDir}/catchup-test-plan.md
{N} features identified, {H} high priority

Next steps:
  /setup-e2e-framework   — scaffold the test framework
  /catchup-e2e           — run again after setup to generate actual tests
```

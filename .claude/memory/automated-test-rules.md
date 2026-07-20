# Automated Test-Case Rules

Read after `ai-usage-rules.md`. These govern automated (e2e) tests — generation
and execution. They build on `.claude/guides/e2e-practices.md`.

## Framework
- Never assume a framework. Resolve via `qa-config.json > testFramework.type`,
  then by scanning the repo (`playwright.config.*`, `cypress.config.*`,
  `wdio.conf.*`, `conftest.py`, `.rspec`). If unknown, scaffold with
  `/setup-e2e-framework` before writing any test code.
- Generate code only for the detected framework. Never mix framework APIs.

## Authoring standards
- **Page Object Model** for all UI interaction — keep selectors out of test
  bodies.
- Selector priority: `data-testid` → ARIA role → accessible text. Avoid CSS
  class / nth-child selectors.
- **No `sleep` or arbitrary waits** — use framework-native async waiting
  (auto-wait, `expect(...).toBeVisible()`, etc.).
- All environment values come from `process.env.*` / the config loader only.
  Never hardcode URLs, credentials, or IDs (see `ai-usage-rules.md` §4).
- Each test maps to a manual test case / acceptance criterion and asserts one
  clear behavior.

## Test data and cleanup
- Create test data through the application's own API or `DataFactory` — never
  direct DB writes unless `qa-config.json > dataManagement.strategy` allows it.
- Register every created entity in `DataFactory` so it can be cleaned up.
- Teardown must call `DataFactory.cleanupAll()` after every run
  (`global-teardown` in Playwright, `after:run` in Cypress).
- Tests must be independent and idempotent — runnable in any order and
  repeatable without manual reset.

## Running tests — production prohibition is absolute
- Run **only** against the staging/test environment from `qa-config.json`
  (`testEnvironmentBaseUrl`). The Layer 5 framework guard, the bash guard, and
  these rules all enforce this — never bypass them.
- Before reporting results, actually execute the suite and read the real output.
  Report pass/fail/skip counts honestly with the failing output included
  (see `ai-usage-rules.md` §5).
- When updating Jira with execution results, only post after the human review
  gate and only the real results.

## CI
- When wiring CI (`/setup-ci`), the workflow must target staging, read all
  secrets from CI secrets (never inline), and keep the production guard active.

# E2E and Framework Practices

## Framework Detection

Never assume a test framework. Resolve in this order:
1. `qa-config.json > testFramework.type`
2. Scan repo for: `playwright.config.*`, `cypress.config.*`, `wdio.conf.*`, `jest.config.*`, `conftest.py`, `.rspec`
3. If still unknown: invoke `/setup-e2e-framework` before writing any test code

Generate code only for the detected framework. Never mix framework APIs.

## Test Data Rules

- Create all test data through the application's own API or data factory — never direct database writes unless `qa-config.json > dataManagement.strategy` explicitly allows it
- Every created entity must be registered in `DataFactory` for cleanup
- `global-teardown` (Playwright) or `after:run` (Cypress) must call `DataFactory.cleanupAll()` after every run
- Never hardcode URLs, credentials, API keys, or environment-specific values in test files — read all from `process.env` or the `qa-config-loader`

## Test Authoring Standards

- Page Object Model for all UI interactions — keep selectors out of test bodies
- Use `data-testid` attributes for selectors; fall back to ARIA roles; avoid CSS classes
- No `sleep` or arbitrary waits — use framework-native async waiting
- All env-specific values come from `process.env.*` only

# setup-e2e-framework

Scaffold an e2e testing framework in the application repository with production safety guards and a data factory / teardown pattern.

## When to invoke

Trigger phrases: "set up e2e framework", "scaffold playwright", "set up cypress", "configure selenium", "initialize e2e tests", "set up end-to-end testing", "create test framework", "add e2e testing", "add WebDriverIO"

## Steps

1. **Read qa-config.json**
   Get `codeRepository.localPath`, `environments.testEnvironmentBaseUrl`, `productionProtection.prodUrlPatterns`, `testFramework`, and `testOutput.e2eTestsPath`. Stop if config is missing.

2. **Confirm the target repo path**
   Verify `codeRepository.localPath` exists. If not set, ask: "Where is the application repository located? (e.g., `../my-app` or `/Users/you/projects/my-app`)"
   Run `ls {localPath}` to confirm it exists.

3. **Detect or select framework**

   Check for existing framework config files in the app repo:
   - `{localPath}/playwright.config.ts` or `playwright.config.js` → Playwright
   - `{localPath}/cypress.config.ts` or `cypress.config.js` → Cypress
   - `{localPath}/wdio.conf.ts` or `wdio.conf.js` → WebDriverIO
   - `{localPath}/jest.config.*` → Jest (for unit/integration, note this is not typically e2e)
   - `{localPath}/conftest.py` → pytest

   If a framework config is found: "I found an existing {framework} configuration. Do you want to (1) extend it with the data factory and safety patterns, or (2) replace it with the full template?"

   If no framework found: ask which to use:
   1. **Playwright** (recommended — built-in parallelism, multiple browsers, excellent DX)
   2. **Cypress** (great for component testing and visual debugging)
   3. **pytest** (Python apps — also works with pytest-playwright for browser tests)
   4. **RSpec** (Ruby on Rails apps — pairs with Faraday for API tests)
   5. **Selenium / WebDriver** (needed for legacy browsers or specific corporate requirements)
   6. **WebDriverIO** (flexible, supports both WebDriver and DevTools protocols)

4. **Install the framework if needed**
   If the framework package is not already installed, show the install command but ask before running:
   - Playwright: `npm install -D @playwright/test && npx playwright install chromium`
   - Cypress: `npm install -D cypress`
   - pytest: `pip install pytest requests python-dotenv` (add `pytest-playwright` for browser tests)
   - RSpec: add `gem 'rspec', 'faraday', 'faraday-json', 'dotenv'` to Gemfile then `bundle install`
   - WebDriverIO: `npm install -D @wdio/cli @wdio/local-runner @wdio/mocha-framework @wdio/spec-reporter node-fetch ts-node typescript && npx wdio config`
   - Selenium: `pip install selenium webdriver-manager pytest requests python-dotenv`

5. **Copy and configure the template**
   Copy the matching template from `templates/e2e/{framework}/` into the app repo.

   **Critical configuration — set from qa-config.json, never hardcode:**
   - `baseURL`: read from `process.env.BASE_URL || qa-config.environments.testEnvironmentBaseUrl`
   - `QA_HARNESS_DIR`: the **absolute path to this harness repo** (`tech9foundry`). This is how the copied template finds `qa-config.json` at test-run time — the harness and app repo are typically sibling directories, not nested, so the template can't find the config by walking up from its own location alone. Compute it with `pwd` from the harness repo root and write it into `{localPath}/.env.test.example` (see step 7).
   - Production URL patterns: optionally also inject as `process.env.QA_PROD_PATTERNS` (a JSON array string) to override or extend `qa-config.json`'s patterns without editing the config — not required when `QA_HARNESS_DIR` is set, since the template reads `productionProtection.prodUrlPatterns` from the config directly.
   - All credentials: read from `process.env.*` only

   The `global-setup.ts` (Playwright), `setupNodeEvents`/config load (Cypress), or `onPrepare` (WebDriverIO) already contains the Layer 5 production guard — it loads `qa-config.json` (via `QA_HARNESS_DIR`) merged with any `QA_PROD_PATTERNS` override, and crashes if `BASE_URL` matches any pattern.

   Update `qa-config.json`:
   - `testFramework.type` = selected framework
   - `testFramework.configPath` = path to the config file
   - `testFramework.testDir` = path to the tests directory
   - `testOutput.e2eTestsPath` = path where tests will be written

6. **Scaffold the data factory**
   The data factory in the template has placeholder entity methods (`createUser`, `createOrder`). Examine the app's codebase to identify the actual entities the application works with:
   - Look at the API routes and data models from the codebase analysis (if available)
   - Generate entity-specific factory methods matching the app's domain
   - Each method should call the app's API (or the mechanism configured in `dataManagement.strategy`)

   If a codebase analysis exists in `{analysisDir}/latest-analysis.md`, use the data models section to populate the factory.

7. **Add `.env.test` template**
   Create `{localPath}/.env.test.example` with:
   ```
   BASE_URL=https://staging.myapp.com
   # Absolute path to this QA harness repo (tech9foundry) — required so the
   # copied e2e template can find qa-config.json and enforce the production
   # guard even when the harness and this app repo are sibling directories.
   QA_HARNESS_DIR=/absolute/path/to/tech9foundry
   # Add credentials and tokens needed for e2e tests here
   # NEVER put production URLs or production credentials in this file
   ```
   Fill in the real `QA_HARNESS_DIR` value (the harness repo's actual absolute path, from `pwd` at the harness root) rather than leaving the placeholder — this is the one value in this file that isn't a secret and should be set correctly, not just documented.
   Add `.env.test` to `{localPath}/.gitignore`

8. **Confirm and report**
   Show:
   - Framework: {type}
   - Config: {configPath}
   - Tests directory: {testDir}
   - Data factory: {dataFactoryPath}
   - Production guard: active (Layer 5)
   
   Say: "E2e framework ready. Run `/write-e2e-tests {ticket-id}` to generate tests for a specific ticket."

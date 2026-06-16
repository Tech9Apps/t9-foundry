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
   - WebDriverIO: `npm install -D @wdio/cli && npx wdio config`

5. **Copy and configure the template**
   Copy the matching template from `templates/e2e/{framework}/` into the app repo.

   **Critical configuration — set from qa-config.json, never hardcode:**
   - `baseURL`: read from `process.env.BASE_URL || qa-config.environments.testEnvironmentBaseUrl`
   - Production URL patterns: inject as `process.env.QA_PROD_PATTERNS` in the globalSetup/setupNodeEvents
   - All credentials: read from `process.env.*` only

   The `global-setup.ts` (Playwright) or `setupNodeEvents` (Cypress) already contains the Layer 5 production guard — it reads `QA_PROD_PATTERNS` and crashes if `BASE_URL` matches any pattern.

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
   # Add credentials and tokens needed for e2e tests here
   # NEVER put production URLs or production credentials in this file
   ```
   Add `.env.test` to `{localPath}/.gitignore`

8. **Confirm and report**
   Show:
   - Framework: {type}
   - Config: {configPath}
   - Tests directory: {testDir}
   - Data factory: {dataFactoryPath}
   - Production guard: active (Layer 5)
   
   Say: "E2e framework ready. Run `/write-e2e-tests {ticket-id}` to generate tests for a specific ticket."

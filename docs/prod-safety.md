# Production Safety

This harness uses five independent layers to prevent tests from running against production environments. Any single layer independently stops production execution — they don't depend on each other.

---

## Layer 1: CLAUDE.md Behavioral Rule

The `CLAUDE.md` file contains an absolute behavioral prohibition that Claude reads on every session start. It refuses to generate or execute any command, configuration, or test that targets a production environment. This is the first gate and the most visible — Claude will explain the violation and suggest the correct staging environment.

**What triggers it:** Any mention of production URLs, `NODE_ENV=production`, "the live site", or "the production database" as a test target.

---

## Layer 2: Session Startup Validation (`hooks/session-init.sh`)

When you open this workspace with `claude`, the `session-init.sh` hook runs before any skills or commands. It:

1. Checks that `qa-config.json` exists (warns if missing)
2. Reads `environments.testEnvironmentBaseUrl` and validates it against every pattern in `productionProtection.prodUrlPatterns`
3. **If the staging URL matches a production pattern: exits with code 2, blocking the session**

This catches misconfiguration before anything else runs. A QA engineer cannot accidentally start working against production if their config is wrong.

**To fix a Layer 2 block:** Edit `qa-config.json > environments.testEnvironmentBaseUrl` to point at your staging environment, then re-open the workspace.

---

## Layer 3: Bash Command Scanning (`hooks/prod-guard.sh`)

Every shell command Claude runs passes through this hook before execution. It scans for:

- Production environment variables: `NODE_ENV=production`, `RAILS_ENV=production`, `APP_ENV=prod`, `--env=production`, etc.
- URLs matching any pattern in `productionProtection.prodUrlPatterns`
- Suspicious URL patterns as a heuristic fallback when patterns aren't configured

**If a match is found:** exits with code 2, blocking the command and surfacing the blocking message to Claude.

This makes it impossible for a mistyped command or a mis-configured test runner to execute against production even if Layers 1 and 2 somehow failed.

---

## Layer 4: File Content Scanning (`hooks/env-detector.sh`)

Every file Claude writes or edits passes through this hook. It scans the new content for:

- URLs matching `productionProtection.prodUrlPatterns`
- Hardcoded `NODE_ENV=production` or equivalent assignments

**If a match is found:** exits with code 2, blocking the write.

This prevents production URLs from being persisted into test configuration files, environment files, or test code.

---

## Layer 5: Framework Runtime Guard (e2e templates)

Every e2e framework template includes a startup guard that runs before any test executes:

**Playwright:** `global-setup.ts` calls `validateNotProduction(baseURL, prodPatterns)` during framework initialization.

**Cypress:** `cypress.config.ts` calls `validateNotProduction` at config load time, before `setupNodeEvents` finishes.

**What it checks:** The resolved `BASE_URL` (from `process.env.BASE_URL` or `qa-config.json`) against all patterns in `productionProtection.prodUrlPatterns`.

**If triggered:** throws a hard error with a clear message, crashing the test run before a single test executes.

This is the final backstop. Even if a QA engineer manually sets `BASE_URL` to a production URL in their terminal and runs the test suite directly (bypassing Claude entirely), the framework will crash before any test touches production.

---

## Configuring Production Patterns

Add your production URLs to `qa-config.json > productionProtection.prodUrlPatterns`. Use regex:

```json
{
  "productionProtection": {
    "prodUrlPatterns": [
      "myapp\\.com$",
      "app\\.myapp\\.com",
      "production\\.myapp\\.com",
      "prod-api\\.myapp\\.com"
    ]
  }
}
```

Rules:
- Use `$` to anchor to the end if your staging URL shares a subdomain structure
- Escape dots: `\\.` not `.`
- Test your patterns before committing: `echo "https://app.myapp.com" | grep -E "app\.myapp\.com"`

---

## What To Do If a Layer Triggers

| Layer triggered | Root cause | Fix |
|----------------|-----------|-----|
| Layer 1 | Prompt mentioned production as test target | Rephrase — target staging instead |
| Layer 2 | `testEnvironmentBaseUrl` is a prod URL | Fix qa-config.json, restart session |
| Layer 3 | Command contains prod URL or env var | Fix the command or test runner config |
| Layer 4 | File being written contains prod URL | Remove the hardcoded URL, use env var |
| Layer 5 | `BASE_URL` env var set to prod | `unset BASE_URL`, set it to staging URL |

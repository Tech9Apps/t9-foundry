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
- Suspicious URL patterns as a heuristic — this always runs as an additional layer (unless `blockOnSuspiciousUrls` is set to `false`), not only when `prodUrlPatterns` is empty. A configured pattern list only covers what's been typed in; the heuristic keeps warning on anything else that looks production-like.

**If a match is found:** the env-var and configured-pattern checks exit with code 2 (blocking); the heuristic check only warns (it never blocks on its own, to avoid false-positive lockouts) and surfaces the warning to Claude.

This makes it impossible for a mistyped command or a mis-configured test runner to execute against production even if Layers 1 and 2 somehow failed.

---

## Layer 4: File Content Scanning (`hooks/env-detector.sh`)

Every file Claude writes or edits passes through this hook. It scans the new content for:

- URLs matching `productionProtection.prodUrlPatterns`
- Hardcoded `NODE_ENV=production` or equivalent assignments
- Suspicious hardcoded URLs as a heuristic fallback — like Layer 3, this always warns as an additional layer (unless `blockOnSuspiciousUrls` is `false`), not only when `prodUrlPatterns` is empty

**If a match is found:** the configured-pattern and env-var checks exit with code 2, blocking the write; the heuristic check only warns.

This prevents production URLs from being persisted into test configuration files, environment files, or test code.

---

## Layer 5: Framework Runtime Guard (e2e templates)

Every e2e framework template includes a startup guard that runs before any test executes:

**Playwright:** `global-setup.ts` calls `validateNotProduction(baseURL, prodPatterns)` during framework initialization.

**Cypress:** `cypress.config.ts` calls `validateNotProduction` at config load time, before `setupNodeEvents` finishes.

**WebDriverIO:** `wdio.conf.ts`'s `onPrepare` hook calls `validateNotProduction` before any spec runs.

**What it checks:** The resolved `BASE_URL` (from `process.env.BASE_URL` or `qa-config.json`) against all patterns in `productionProtection.prodUrlPatterns`.

**Finding `qa-config.json`:** the harness repo and the app repo are normally sibling directories (see the README's recommended layout), not nested — so this layer only works if `QA_HARNESS_DIR` (the harness repo's absolute path) is set in `.env.test`. `/setup-e2e-framework` writes this into `.env.test.example` when it scaffolds the template; if it's missing or wrong, this layer silently falls back to `QA_PROD_PATTERNS` (if set) or the heuristic-only check below — set `QA_HARNESS_DIR` correctly rather than relying on the heuristic as your only backstop.

**If triggered:** throws a hard error with a clear message, crashing the test run before a single test executes.

This is the final backstop. Even if a QA engineer manually sets `BASE_URL` to a production URL in their terminal and runs the test suite directly (bypassing Claude entirely), the framework will crash before any test touches production.

---

## Guard Modes: `warn` and `enforce`

The suspicious-URL heuristic (Layers 3, 4 and 5) has two modes:

| Mode | Heuristic match | Empty `prodUrlPatterns` | Missing / malformed `qa-config.json` | When |
|------|-----------------|-------------------------|--------------------------------------|------|
| `warn` (default) | prints a warning | warns at session start | prints setup guidance (malformed config blocks) | a human is at the keyboard |
| `enforce` | **blocks** (exit 2 / throws) | **blocks the session** | **blocks the session** | unattended runs — a warning nobody reads is not a guard |

Enforce is selected by **`QA_AUTONOMOUS=1`** (set by autonomous entry points; overrides the config) or by
`productionProtection.mode: "enforce"` in `qa-config.json`. Configured `prodUrlPatterns` and production env-var
checks block in **both** modes — `enforce` only changes what happens to the *heuristic*.

Because enforce blocks anything that merely *looks* like production, two escape hatches exist:

- **Built-in exemptions** — tracker and code-host URLs the pipeline legitimately calls (`github.com`, `gitlab.com`,
  `bitbucket.org`, `dev.azure.com`, `api.clickup.com`, `atlassian.net`, `localhost`) never trip the heuristic.
- **`productionProtection.allowedUrlPatterns`** — regexes for other known-safe URLs (docs sites, CDNs). These exempt
  the heuristic **only**; they never override `prodUrlPatterns`.

Layer 4 never blocks documentation files (`.md`, `.txt`, `.rst`) on the heuristic — they legitimately link out — it
only warns. URLs are judged **one at a time**: a staging URL elsewhere in the same command does not excuse a
production-looking one.

`blockOnSuspiciousUrls: false` disables the heuristic entirely (in either mode) and is honored as an explicit opt-out;
`scripts/preflight.sh` warns when it is combined with `enforce`.

### Preflight

`scripts/preflight.sh` is the go/no-go gate for an autonomous run. It checks: `jq`; config present and valid; required
sections; staging URL set, not matching a production pattern; `prodUrlPatterns` non-empty and each a valid regex;
ticket-source credentials (`AZURE_DEVOPS_PAT`, `CLICKUP_TOKEN`, ..., Bitbucket username); the app repo's `.env.test`
`QA_HARNESS_DIR` resolving to this harness (so Layer 5 can find the config); and staging reachability / `gh auth`
(skip with `--skip-network`). Exit 0 = go, 1 = no-go.

```bash
QA_AUTONOMOUS=1 bash scripts/preflight.sh
```

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

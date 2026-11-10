# Production Safety

This harness uses five independent layers to prevent tests from running against production environments. Any single layer independently stops production execution — they don't depend on each other.

---

## Layer 1: CLAUDE.md Behavioral Rule

The `CLAUDE.md` file contains an absolute behavioral prohibition that Claude reads on every session start. It refuses to generate or execute any command, configuration, or test that targets a production environment. This is the first gate and the most visible — Claude will explain the violation and suggest the correct staging environment.

**What triggers it:** Any mention of production URLs, `NODE_ENV=production`, "the live site", or "the production database" as a test target.

---

## Layer 2: Session Startup Notice (`hooks/session-init.sh`)

When you open this workspace with `claude`, the `session-init.sh` hook runs before any skills or commands. It checks `qa-config.json` and **tells you** if:

1. the file is malformed, or missing while guard mode is `enforce`;
2. in `enforce` mode, `productionProtection.prodUrlPatterns` is empty or `environments.testEnvironmentBaseUrl` is not set;
3. `environments.testEnvironmentBaseUrl` matches a production pattern, in any mode and in any spelling (case, userinfo, port, trailing dot).

**This layer informs; it does not stop anything.** Claude Code does not block a session when a `SessionStart` hook fails: exit code 2 there shows you the hook's stderr as a notice and the session carries on. The condition is enforced by **Layer 3**: `prod-guard.sh` asks the same code (`hooks/lib/url-guard.js`) the same questions before every shell command and **refuses every command while any of them holds**. So a misconfigured workspace can open, but it cannot run a shell command.

**To fix it:** edit `qa-config.json` (with the Write or Edit tool, or by hand) so that `environments.testEnvironmentBaseUrl` points at your staging environment and, in `enforce` mode, both it and `prodUrlPatterns` are set. The next command runs.

---

## Layer 3: Bash Command Scanning (`hooks/prod-guard.sh`)

Every shell command Claude runs passes through this hook before execution. It scans for:

- Production environment variables: `NODE_ENV=production`, `RAILS_ENV=production`, `APP_ENV=prod`, `--env=production`, etc.
- URLs matching any pattern in `productionProtection.prodUrlPatterns`, in every spelling a command can use (see "What counts as a URL" below)
- URLs that are not recognizably a test environment — judged by the shared host decision described under "Guard Modes" below; this always runs as an additional layer (unless `blockOnSuspiciousUrls` is `false`), not only when `prodUrlPatterns` is empty. A configured pattern list only covers what has been typed in.

**If a match is found:** the env-var and configured-pattern checks exit with code 2 (blocking). An unrecognized host only warns in `warn` mode (a human is watching) and blocks in `enforce` mode.

**It also refuses every command while the configuration is unsafe** (the checks Layer 2 can only announce): no `qa-config.json`, no `prodUrlPatterns` or no staging URL in `enforce` mode, or a staging URL that is itself a production URL in any mode. And without `jq` it cannot read a command at all, so `enforce` mode blocks and `warn` mode warns. Every reason is printed to stderr, which is what Claude Code shows Claude when a hook blocks.

This catches a mistyped command or a mis-configured test runner that names a production URL, even if Layers 1 and 2 somehow failed. It reads URLs, not intent — see "What this cannot see" under Guard Modes for what it does not cover.

---

## Layer 4: File Content Scanning (`hooks/env-detector.sh`)

Every file Claude writes or edits passes through this hook. It scans the new content for:

- URLs matching `productionProtection.prodUrlPatterns`
- Hardcoded `NODE_ENV=production` or equivalent assignments
- Hardcoded URLs that are not recognizably a test environment (the same host decision as Layer 3), as an additional layer even once `prodUrlPatterns` is configured

**If a match is found:** the configured-pattern and env-var checks exit with code 2, blocking the write; an unrecognized host warns in `warn` mode and blocks (non-documentation files) in `enforce` mode.

This prevents production URLs from being persisted into test configuration files, environment files, or test code.

---

## Layer 5: Framework Runtime Guard (e2e templates)

Every e2e framework template includes a startup guard that runs before any test executes:

**Playwright:** `global-setup.ts` calls `validateNotProduction(baseURL, prodPatterns)` during framework initialization.

**Cypress:** `cypress.config.ts` calls `validateNotProduction` at config load time, before `setupNodeEvents` finishes.

**WebDriverIO:** `wdio.conf.ts`'s `onPrepare` hook calls `validateNotProduction` before any spec runs.

**What it checks:** The resolved `BASE_URL` (from `process.env.BASE_URL` or `qa-config.json`) against all patterns in `productionProtection.prodUrlPatterns` — in any spelling — and then the same host decision as Layers 3 and 4 (see "Guard Modes"). The TypeScript, Python and Ruby implementations are ports of one reference and are tested against the same case table, so they decide identically. A `qa-config.json` that exists but cannot be read stops an unattended run (`QA_AUTONOMOUS=1`) instead of letting it continue without its patterns.

**Finding `qa-config.json`:** the harness repo and the app repo are normally sibling directories (see the README's recommended layout), not nested — so this layer only works if `QA_HARNESS_DIR` (the harness repo's absolute path) is set in `.env.test`. `/setup-e2e-framework` writes this into `.env.test.example` when it scaffolds the template; if it's missing or wrong, this layer silently falls back to `QA_PROD_PATTERNS` (if set) or the heuristic-only check below — set `QA_HARNESS_DIR` correctly rather than relying on the heuristic as your only backstop.

**If triggered:** throws a hard error with a clear message, crashing the test run before a single test executes.

This is the final backstop. If a QA engineer manually sets `BASE_URL` to a production URL in their terminal and runs the test suite directly (bypassing Claude entirely), the framework crashes before any test runs when the URL matches `prodUrlPatterns`, or — in `enforce` mode — when it is not recognizably a test environment. In `warn` mode an unrecognized host only warns, so keep `prodUrlPatterns` complete.

---

## Guard Modes: `warn` and `enforce`

Every layer that looks at URLs (3, 4 and 5) asks the same question about each one: **is it recognizably a test
environment?** One reference implementation (`hooks/lib/url-guard.js`) answers it for the shell hooks; the runtime guards
in the e2e templates (TypeScript ×3, Python ×2, Ruby) are ports of it, and a shared table of 118 cases
(`tests/fixtures/guard-cases.json`, including every bypass a review found) is run against **all** of them and against the
real hooks, in both modes, so they cannot quietly disagree.

The decision, in order, for each URL:

1. A configured **`prodUrlPatterns`** regex matches **any normalized spelling** of the URL → **block** (both modes). The spellings
   tried: as typed, without userinfo / query / fragment, with and without the port, the host alone, a trailing-dot host,
   and — for numeric hosts — the dotted-quad form of the same address (`http://3405803783/`, `0xcb007107` and
   `203.0.113.7` are one address). Matching is case-insensitive.
2. `blockOnSuspiciousUrls: false` → allow (an explicit opt-out; enforce mode never overrides it).
3. The host **cannot be verified** (a shell variable, an escape, a backslash in the authority, a non-plain character, not
   http(s)) → block in `enforce`, warn in `warn`.
4. **Known-good** → allow: a tracker / code host / package registry (`github.com`, `gitlab.com`, `bitbucket.org`,
   `dev.azure.com`, `api.clickup.com`, `atlassian.*`, `registry.npmjs.org`, `pypi.org`, `rubygems.org`, …, matched on a
   whole domain label — `github.com.evil.com` is not `github.com`), a URL matching `allowedUrlPatterns`, or the exact host of
   `environments.testEnvironmentBaseUrl`.
5. **Recognizably not production** → allow: a host *label* such as `staging`, `test`, `dev`, `qa`, `uat`, `sandbox`, `preview`
   (never a substring: `devices`, `aqua` and `attestation` do not count; the TLD is ignored, so `acme.dev` is not a dev host; a
   `prod`/`production`/`live` label wins, so `test-prod.acme.com` is not exempt), a reserved TLD (`.test`, `.example`,
   `.invalid`, `.local`, `.localhost`), `example.com`, or a loopback / private / link-local address.
6. **Anything else is an unrecognized host** → block in `enforce`, warn in `warn`.

| Mode | Unrecognized host | Unverifiable host | Empty `prodUrlPatterns` | Missing config | Malformed `qa-config.json` | `node` missing (hooks) | When |
|------|-------------------|-------------------|-------------------------|----------------|------------------------------|------------------------|------|
| `warn` (default) | warns | warns | warns at session start | setup guidance | **warns** that no production pattern is being applied | warns | a human is at the keyboard |
| `enforce` | **blocks** | **blocks** | **blocks every command** (Layer 3; session start only notifies) | **blocks every command** (same) | **blocks** | **blocks** | unattended runs — a warning nobody reads is not a guard |

In `enforce` mode an unset `testEnvironmentBaseUrl` blocks every command too, and in **both** modes a staging URL that matches a production pattern does.

Enforce is selected by **`QA_AUTONOMOUS=1`** (set by autonomous entry points; overrides the config) or by
`productionProtection.mode: "enforce"` in `qa-config.json`. Configured `prodUrlPatterns` and production env-var checks
block in **both** modes. Enforce therefore works as an **allowlist**: a host the guard cannot positively recognize does not
run. If that blocks something legitimate, add its host to `allowedUrlPatterns`.

Write your patterns **anchored** (`://myapp\\.example\\.com/`, not `myapp\\.example\\.com`): a pattern is a regular expression, so an
unanchored one matches every host that merely ends with it — staging subdomains included. `allowedUrlPatterns` are matched
against the URL **without** its query string and fragment (text after `?` or `#` cannot satisfy them), and a match has to **start
inside the scheme and host**: `://partner\\.io/guide` allows `https://partner.io/guide/setup`, but not
`https://evil.com/go/https://partner.io/guide` (the same text, but inside another host's path), and a pattern that is only a path
(`/guide`) allows no host at all. Do not start an allow pattern with `.*`: it can begin matching at the start of any URL, so it
says "anything, then `partner.io/guide`". An invalid regex never exempts anything.

**What counts as a URL.** curl, browsers and HTTP libraries accept far more than `https://host/path`, so the shell hooks (Layers 3 and 4) read
every spelling, in a command or in file content:

| Spelling | Examples | Judged by |
|----------|----------|-----------|
| `http(s)` with the slashes wrong | `https:/host`, `http:///host`, `HTTPS:/host`, `https:host` | the full decision above, exactly like `https://host` |
| protocol-relative | `//host/path`, `--url=//host` | the full decision (a host that looks like one: `ls //tmp/x` is not read as a URL) |
| a backslash after the scheme | `https:\\host` | the full decision: unverifiable (the guard does not guess), so `enforce` blocks |
| another scheme | `ftp://host`, `sftp://user@host`, `postgresql://host` | **`prodUrlPatterns` only** |
| a bare host | `curl myapp.example.com/x`, `user@host`, `BASE=host/x npm test` | **`prodUrlPatterns` only** |

The last two are checked against your production patterns only, because they cannot be judged by the "is it a test environment?" rules
without blocking ordinary commands: a bare token cannot be told from a file name (`out.json`, `app.config.js`), and `git clone
ssh://…` is routine. The consequence is worth knowing: **in `enforce` mode an unknown host written without a scheme is not blocked
unless a production pattern matches it.** Keep `prodUrlPatterns` complete, and write them against the host (`://myapp\\.example\\.com/`
matches every spelling above, because the reader tries the normalized `https://host…` form of each).

Layer 4 never blocks documentation files (`.md`, `.txt`, `.rst`) on an unrecognized host — they legitimately link out — it only
warns. URLs are judged **one at a time**: a staging URL elsewhere in the same command does not excuse a production-looking one.

`blockOnSuspiciousUrls: false` disables the host heuristic entirely (in either mode); `scripts/preflight.sh` warns when it is
combined with `enforce`.

**What this cannot see.** The guard reads URLs; it does not read intent or the network. It does **not** cover: a redirect from an
allowed host to a production one; DNS that points a staging name at production; a hostname assembled by a program at run time
(in `enforce` a host written as a shell variable is blocked, but a program that builds its own URL is not seen); a target given
without a URL (`ssh prod-db`; a bare hostname is matched against `prodUrlPatterns` only, see above); or a command that never mentions the target (a script reading its URL
from a file). Layer 5 (the runtime guard) is the backstop for the test runner itself; for everything else, `prodUrlPatterns`
and your network controls are the real protection.

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
| Layer 2 | `testEnvironmentBaseUrl` is a prod URL, or (enforce) patterns / staging URL missing | Fix qa-config.json; until then Layer 3 refuses every shell command |
| Layer 3 | Command contains prod URL or env var | Fix the command or test runner config |
| Layer 4 | File being written contains prod URL | Remove the hardcoded URL, use env var |
| Layer 5 | `BASE_URL` env var set to prod | `unset BASE_URL`, set it to staging URL |

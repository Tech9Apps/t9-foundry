# troubleshoot

Run a structured diagnostic over the harness and report what is broken, with actionable
fix instructions for each issue. Can be triggered contextually ("this isn't working") or
invoked directly.

## When to invoke

Trigger phrases: "troubleshoot", "something is broken", "not working", "help me debug",
"Jira isn't responding", "token expired", "prod guard is blocking my staging URL",
"why is the harness blocking me", "nothing is working", "diagnose", "/troubleshoot"

## Steps

Run all diagnostic checks below in order. Collect results and present a single report at
the end (do not interleave findings with running commentary). Use ✓, ✗, and ⚠ to mark
each check.

---

### Check 1 — Config file

Run: `jq . qa-config.json`

- **Missing:** ✗ `qa-config.json not found — Run /init to configure this workspace.`
- **Invalid JSON:** ✗ `qa-config.json is malformed. jq error: {error message}.`
  Fix: open `qa-config.json` in an editor and fix the syntax error on the reported line.
- **Missing required keys:** check for `project.name`, `ticketSource.type`,
  `codeRepository.type`, `environments.testEnvironmentBaseUrl`,
  `productionProtection.prodUrlPatterns`.
  For each missing key: ✗ `{key} is not set.` Fix: Run `/reconfigure` to add it.
- **All present and valid:** ✓ `qa-config.json — valid`

---

### Check 2 — Ticket source connectivity

Read `ticketSource.type` from config.

#### Jira
- Call `mcp__claude_ai_Atlassian__atlassianUserInfo`
- Success: ✓ `Jira (Atlassian MCP) — connected as {displayName}`
- Failure: ✗ `Jira (Atlassian MCP) — not responding`
  Fix: Go to claude.ai → Integrations → Atlassian and reconnect. Then re-run `/troubleshoot`.

#### ClickUp
- Check if `CLICKUP_TOKEN` is set: `bash -c 'test -n "$CLICKUP_TOKEN" && echo set || echo unset'`
- If unset: ✗ `CLICKUP_TOKEN is not set`
  Fix: `export CLICKUP_TOKEN=your_token` — add this line to `~/.zshrc` or `~/.bashrc`,
  then run `source ~/.zshrc` (or open a new terminal).
- If set: test connectivity: `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $CLICKUP_TOKEN" https://api.clickup.com/api/v2/user`
  - 200: ✓ `ClickUp — authenticated`
  - 401: ✗ `ClickUp — token rejected (401). Generate a new token at app.clickup.com → Profile → Apps.`
  - Other: ⚠ `ClickUp — unexpected status {code}. Check your network or ClickUp status page.`

#### GitHub Issues
- Run `gh auth status`
- Success: ✓ `GitHub CLI — authenticated as {username}`
- Failure: ✗ `GitHub CLI — not authenticated`
  Fix: `gh auth login` — follow the browser prompt.

#### GitLab
- Check if `GITLAB_TOKEN` is set: `bash -c 'test -n "$GITLAB_TOKEN" && echo set || echo unset'`
- If unset: ✗ `GITLAB_TOKEN is not set`
  Fix: Create a token at {gitlab host} → User Settings → Access Tokens (scope: `api`).
  Then `export GITLAB_TOKEN=your_token` and add to `~/.zshrc`.
- If set, read `ticketSource.gitlab.host` and run a lightweight check:
  `curl -s -o /dev/null -w "%{http_code}" -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "{host}/api/v4/user"`
  - 200: ✓ `GitLab — authenticated`
  - 401: ✗ `GitLab — token rejected. Verify the token has 'api' scope and hasn't expired.`

#### Bitbucket
- Check if `BITBUCKET_TOKEN` is set: `bash -c 'test -n "$BITBUCKET_TOKEN" && echo set || echo unset'`
- If unset: ✗ `BITBUCKET_TOKEN is not set`
  Fix: Create an App Password at bitbucket.org → Account Settings → App Passwords.
  Then `export BITBUCKET_TOKEN=your_token` and add to `~/.zshrc`.
- If set: ✓ `Bitbucket — token is set (connectivity not auto-verified)`

#### None
- ✓ `Ticket source: none — no connectivity check needed`

---

### Check 3 — Staging URL vs. production patterns

Read `testEnvironmentBaseUrl` and `productionProtection.prodUrlPatterns`.

- If `testEnvironmentBaseUrl` is empty: ✗ `testEnvironmentBaseUrl is not set.`
  Fix: Run `/reconfigure` → option 1.
- If `prodUrlPatterns` is empty or missing: ⚠ `prodUrlPatterns is empty — production blocking is disabled.`
  Fix: Run `/reconfigure` → option 5.
- For each pattern, test: `echo "{testEnvironmentBaseUrl}" | grep -E -e "{pattern}" && echo match || echo ok`
  - Any match: ✗ `Staging URL matches production pattern: {pattern}`
    Fix: The pattern `{pattern}` is too broad — it is catching your staging URL.
    Either narrow the pattern (e.g., anchor it with `^` or `$`) or use `/reconfigure` to
    update both the URL and the patterns.
  - No matches: ✓ `Staging URL — passes all {N} production pattern checks`

---

### Check 4 — Test framework

Read `testFramework.type` and `testFramework.configPath`.

- If `testFramework.type` is not set: ⚠ `No test framework configured.`
  Fix: Run `/setup-e2e-framework` to scaffold one.
- If `configPath` is set, check the file exists: `ls "{testFramework.configPath}"`
  - Found: ✓ `Test framework ({type}) — config found at {configPath}`
  - Not found: ✗ `Test framework config not found: {configPath}`
    Fix: Run `/setup-e2e-framework` to create it, or run `/reconfigure` → option 4 to
    update the path.

---

### Check 5 — Output directories

Check that each configured output directory exists (or can be created):
- `jq -r '.testOutput.testPlansDir // "./test-plans"' qa-config.json`
- `jq -r '.testOutput.testCasesDir // "./test-cases"' qa-config.json`
- `jq -r '.testOutput.analysisDir // "./analysis"' qa-config.json`

For each: `test -d "{dir}" && echo exists || echo missing`
- Exists: ✓ `{dir} — exists`
- Missing: ⚠ `{dir} — not found (will be created on first use)`

---

### Check 6 — Prerequisites

Run `bash scripts/check-prereqs.sh` and include its output in the report.

---

### Final report

Present all findings together:

```
Diagnostic Report — {project.name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✓  qa-config.json — valid
✗  Ticket source ({type}) — {error}
     Fix: {fix instruction}
⚠  {check name} — {warning}
     Fix: {fix instruction}
✓  Staging URL — passes all {N} production pattern checks
✓  Output directories — all present
```

If all checks pass: "Everything looks good. No issues detected. If you are still seeing
a problem, describe it and I will investigate further."

If any checks fail: list only the failed/warned checks with their fix instructions,
then ask: "Would you like help fixing any of these now?"

# init

One-command workspace setup. Asks targeted questions about your project and environment, configures your ticket source and code repository inline, and produces security and performance checklists tailored to your stack.

## When to invoke

Trigger phrases: "set up this workspace", "initialize", "get started", "configure workspace", "first time setup", "run init", "onboard", "I just cloned this repo", "workspace setup", "/init"

## Steps

### Phase 1 — Diagnostic Questions

Open with: "Welcome to the Tech9 QA Harness. I'll walk you through workspace setup — 7 quick questions about your project, then I'll configure everything and generate security and performance checklists tailored to your stack."

Ask one question at a time. After presenting a question and its options, stop and wait for the user's response before asking the next question. Do not present multiple questions in one message. As you receive each answer, remember it for use in later phases.

Format each question header as **Question N of 7 — \<topic\>**. List every option on its own line with a short bold label and a brief note about any prerequisite (token, CLI, MCP connection, etc.).

---

**Question 1 of 7 — Ticket system**
What ticket system does your team use for this project?

- **Jira** — requires Atlassian MCP connected (claude.ai → Integrations → Atlassian)
- **Azure DevOps** — requires a Personal Access Token (Work Items, Read & write) set in your shell profile
- **ClickUp** — requires `CLICKUP_TOKEN` set in your shell profile
- **GitHub Issues** — requires GitHub CLI installed and authenticated (`gh auth login`)
- **GitLab Issues** — requires `GITLAB_TOKEN` set in your shell profile
- **Bitbucket Issues** — requires `BITBUCKET_TOKEN` set in your shell profile
- **No ticket system** — I'll collect requirements directly in the session

Wait for the answer, then ask:

---

**Question 2 of 7 — Application repo**
What is the application you're testing, and where is the code?

- **Local path** — provide the path to your app repo clone (e.g., `../my-app`)
- **Remote only** — provide the remote identifier (e.g., `owner/repo` for GitHub, project ID for GitLab)
- **Both** — provide both the local path and the remote identifier

Wait for the answer, then ask:

---

**Question 3 of 7 — Application type**
What kind of application is it?

1. Web SPA (React, Vue, Angular, Svelte)
2. REST API (Node.js, Python, Rails, Java, Go)
3. Full-stack monolith (Rails MVC, Django, Laravel, Next.js SSR)
4. Microservices / distributed system
5. Mobile web (responsive / React Native Web)
6. GraphQL API

Wait for the answer, then ask:

---

**Question 4 of 7 — Primary tech stack**
What's the primary tech stack?

Examples: React + Node.js, Python/FastAPI, Ruby on Rails, Java/Spring Boot, Go + Postgres. Describe what you know — any detail helps.

Wait for the answer, then ask:

---

**Question 5 of 7 — Test framework**
Do you have an existing test framework in the app repo, or will you be setting one up?

- **Playwright** — where is `playwright.config.ts`? (approximate path is fine)
- **Cypress** — where is `cypress.config.ts`?
- **pytest** — is there a `conftest.py` at the project root?
- **WebDriverIO, RSpec, Jest, or other** — which framework, and where is its config?
- **Not yet** — I'll recommend one based on your stack after setup

Wait for the answer, then ask:

---

**Question 6 of 7 — Sensitive data**
Does this application handle any of the following? (select all that apply)

- **PII** — names, emails, addresses, or other personally identifiable information
- **Financial** — credit cards, transactions, or bank account data
- **Healthcare** — medical records, diagnoses, or other PHI (HIPAA)
- **Auth secrets** — OAuth tokens, API keys, or credentials stored in the app
- **None of the above**

Wait for the answer, then ask:

---

**Question 7 of 7 — Team context**
What's the team size and QA model?

- Solo developer, self-testing
- Small team (2–5 devs), 1 dedicated QA
- Medium team (6–15 devs), 1–2 QA
- Large team (15+ devs), dedicated QA team

---

After receiving the answer to Question 7, read `qa-config.json` if it exists. If both `ticketSource.type` and `codeRepository.type` are already set, pause and ask: "Your workspace is already configured (ticket source: {type}, repository: {type}). Do you want to (1) reconfigure from scratch, or (2) continue and fill in any missing fields?"

### Phase 2 — Acknowledge and Confirm Understanding

Briefly confirm your understanding before proceeding:
- Restate the project name, app type, and stack in one line
- Flag any credential or tool setup that must happen before configuration can proceed (e.g., "You'll need to set `CLICKUP_TOKEN` in your shell profile before I can test connectivity — run `export CLICKUP_TOKEN=your_token`, add it to `~/.zshrc`, then restart your terminal")
- If no test framework was specified, recommend one: Playwright for JS/TS apps, pytest for Python projects, Cypress as an alternative for JS
- Ask follow-up clarifications for anything ambiguous; do not continue with assumptions

### Phase 3 — Security Best Practices Checklist

Generate a tailored markdown checklist and display it before starting configuration. Always include:

```
Security Testing Checklist — {Project Name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Universal:
  [ ] Never commit credentials — use environment variables
  [ ] Use dedicated test accounts — never share production user credentials
  [ ] Staging environment is isolated from production data
  [ ] Production URL blocklist is configured in qa-config.json
  [ ] Auth flow: valid login, invalid login, session expiry, logout
  [ ] Rate limiting: test for 429 responses under repeated requests
  [ ] Error messages do not expose stack traces or internal paths
```

Add these sections based on the engineer's sensitive data selection:

**If PII:**
```
PII / Data Privacy:
  [ ] User A cannot read or modify User B's records (IDOR test)
  [ ] Deleted users' data is actually removed (GDPR/CCPA right to erasure)
  [ ] PII is not logged in plaintext
  [ ] API responses mask or redact PII for unauthorized roles
  [ ] Export features (if any) require re-authentication
```

**If Financial:**
```
Financial / Payment:
  [ ] Use test card numbers only — never real payment credentials
  [ ] Client-submitted amounts cannot override server-computed amounts
  [ ] Duplicate submissions do not double-charge (idempotency)
  [ ] Currency precision: test at rounding boundaries (e.g., $0.001 scenarios)
  [ ] Card numbers never appear in logs, URLs, or API responses (PCI DSS)
  [ ] Refund amounts match original transaction amounts
```

**If Healthcare / HIPAA:**
```
Healthcare / HIPAA:
  [ ] PHI never appears in logs
  [ ] All access to patient records is logged (audit trail)
  [ ] Role-based access: nurse vs. doctor vs. admin scopes are enforced
  [ ] Test data uses synthetic patients only — never real patient records
```

**If Web SPA (app type):**
```
SPA-Specific:
  [ ] XSS: test user-input fields for script injection
  [ ] CSRF: state-changing requests require CSRF tokens or SameSite cookies
  [ ] Auth tokens stored in httpOnly cookies, not localStorage
  [ ] Open redirect: redirect params cannot point to external domains
```

**If REST API (app type):**
```
API-Specific:
  [ ] Input validation: missing required fields, wrong types, excessively long strings, special characters
  [ ] Expired tokens, tampered tokens, and missing Authorization headers return 401/403
  [ ] HTTP method enforcement: e.g., DELETE /users rejects GET requests
  [ ] Mass assignment: extra fields in request body do not update protected attributes
  [ ] Pagination: very large offset/limit values do not cause timeouts
  [ ] SSRF: URL-accepting endpoints reject internal network addresses
```

**If GraphQL (app type):**
```
GraphQL-Specific:
  [ ] Introspection is disabled in the production environment
  [ ] Query depth limiting is enforced (prevent deeply nested queries)
  [ ] Query batching abuse is rate-limited
  [ ] Field-level authorization: user cannot access fields outside their role
```

Close with: "This checklist is your security test planning reference. Each checked item should map to one or more test cases in your test plan."

### Phase 4 — Performance and Responsiveness Best Practices

Always include:
```
Performance Testing Guidance — {Project Name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Universal:
  [ ] Set response time assertions — target p95 < 500ms for API calls
  [ ] Use realistic payload sizes — not just trivial 1-record examples
  [ ] Do not assume staging is fast because it's under no load
  [ ] Playwright: add trace: 'on-first-retry' to playwright.config.ts
```

Based on app type, add:

**Web SPA:**
```
  [ ] Page load time: first meaningful paint < 3s on staging
  [ ] Core Web Vitals awareness: LCP, INP, CLS
  [ ] Lazy loading: below-the-fold content does not block initial render
  [ ] Test with throttled network (Playwright: use browser context network conditions)
  [ ] Bundle size regression: flag if build output grows > 20% between releases
```

**REST API:**
```
  [ ] p95 < 500ms for read endpoints, < 1000ms for write endpoints
  [ ] N+1 query check: create 50 records and verify response time does not scale linearly
  [ ] Pagination: test last-page requests, not just first-page
  [ ] List endpoints: assert they do not return unbounded result sets
```

**Full-stack monolith:**
```
  [ ] Watch for N+1 queries per page load
  [ ] Cache hit vs. miss: cached response is measurably faster
  [ ] Background job queue does not grow unboundedly under load
  [ ] Session store lookup adds < 50ms to response times
```

**GraphQL:**
```
  [ ] Resolver-level timing: slow resolvers are identified in tracing
  [ ] N+1 resolver detection: use DataLoader or equivalent batching
  [ ] Query complexity scoring: reject queries above a complexity threshold
```

### Phase 5 — Ticket Source Configuration

Frame: "Now I'll configure your ticket source."

Execute the `connect-tickets.md` configuration logic directly — the ticket system is already known from Phase 1, so skip the source-selection question and go straight to source-specific steps:

- **Jira:** verify Atlassian MCP with `mcp__claude_ai_Atlassian__atlassianUserInfo`, ask for project key, confirm it via `getVisibleJiraProjects`, detect issue types, write config
- **Azure DevOps:** check the PAT env var (default `AZURE_DEVOPS_PAT`), ask for organization and project, test connectivity, write config
- **ClickUp:** check `$CLICKUP_TOKEN`, ask for Workspace ID and List ID, test connectivity, write config
- **GitHub Issues:** run `gh auth status`, ask for `owner/repo`, test with `gh repo view`, ask for label name (default: `test-case`), write config
- **GitLab Issues:** check `$GITLAB_TOKEN`, ask for project ID and host, test with curl, write config
- **Bitbucket:** check `$BITBUCKET_TOKEN`, ask for workspace and repo slugs, test connectivity, write config
- **No ticket system:** write `ticketSource.type = "none"`, no connectivity check needed

Verify by fetching one real ticket (skip for `type = "none"`). When done, proceed immediately to Phase 6 without asking the engineer to run a separate skill.

### Phase 6 — Repository Configuration

Frame: "Now I'll configure your code repository."

Execute the `connect-repo.md` configuration logic directly — the repo location and remote identifier are known from Phase 1 answers. Use them to pre-fill; only ask for missing details:

- Write `project.name` from the application name given in Phase 1
- Confirm or ask for the remote repo type (GitHub / GitLab / Bitbucket / local only)
- Set `codeRepository.localPath` from the Phase 1 local path answer
- Write the repo-type-specific sub-fields:
  - GitHub: `codeRepository.github.repo` (owner/repo format)
  - GitLab: `codeRepository.gitlab.projectId` (numeric ID or namespace/path) and `codeRepository.gitlab.host` (default: `https://gitlab.com`)
  - Bitbucket: `codeRepository.bitbucket.workspace` and `codeRepository.bitbucket.repo`
- Ask for the staging environment URL (`testEnvironmentBaseUrl`)
- Ask for production URL patterns to block (`prodUrlPatterns`) — suggest reasonable defaults based on the staging URL, written ANCHORED to the scheme and host (e.g., if staging is `staging.myapp.com`, suggest `://myapp\.com(/|:|$)` and `://app\.myapp\.com(/|:|$)`). Never suggest an unanchored `myapp.com$`: it also matches `staging.myapp.com`, and a config whose staging URL matches a production pattern stops every shell command
- Validate the staging URL does not match any of the prod patterns before writing to config (same check as `session-init.sh`). If it matches, stop and ask the engineer to correct it.

Write all fields to `qa-config.json`.

### Phase 7 — Auto-populate Remaining Fields

After ticket source and repo are configured, write the remaining fields from Phase 1 answers without asking additional questions:

**testFramework** — from the framework answer:
- Playwright → `type: "playwright"`, `configPath: "{localPath}/playwright.config.ts"`, `testDir: "{localPath}/e2e"`
- Cypress → `type: "cypress"`, `configPath: "{localPath}/cypress.config.ts"`, `testDir: "{localPath}/cypress/e2e"`
- pytest → `type: "pytest"`, `testDir: "{localPath}"`
- WebDriverIO → `type: "webdriverio"`
- RSpec → `type: "rspec"`, `testDir: "{localPath}/spec"`
- Not yet → leave `testFramework` unset; note `/setup-e2e-framework` in the final summary

**dataManagement.strategy** — from app type:
- REST API → `"factory"`
- Web SPA → `"factory"`
- Full-stack monolith → `"factory"` (mention `"seed-rollback"` if Docker is available)
- Microservices → `"tag-cleanup"`
- GraphQL API → `"factory"`

**testOutput** — always set these defaults:
- `testPlansDir: "./test-plans"`
- `testCasesDir: "./test-cases"`
- `analysisDir: "./analysis"`
- `e2eTestsPath`: set to `{testFramework.testDir}` if a framework was configured; leave unset otherwise

### Phase 8 — Validation Pass

1. Read the config: `jq . qa-config.json`
2. Confirm required fields are populated: `project.name`, `ticketSource.type`, `codeRepository.type`, `environments.testEnvironmentBaseUrl`, `productionProtection.prodUrlPatterns` (non-empty array)
3. URL safety check: verify `testEnvironmentBaseUrl` does not match any pattern in `prodUrlPatterns`
4. If `testFramework.configPath` is set, confirm the file exists at that path
5. Run `bash scripts/check-prereqs.sh`
6. Report each check with ✓/⚠/✗. On any failure, explain what's wrong and how to fix it. On all passing, proceed to the final summary.

### Phase 9 — Final Summary

```
Workspace Initialized — {Project Name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Configuration:
  ✓ Ticket source:        {type} / {project-or-repo}
  ✓ Code repository:      {type} / {repo-or-path}
  ✓ Local repo:           {localPath}
  ✓ Test environment:     {testEnvironmentBaseUrl}
  ✓ Production patterns:  {N} patterns blocking production
  ✓ Test framework:       {type  — or "not configured, see below"}
  ✓ Data strategy:        {strategy}
  ✓ Test output:          ./test-plans, ./test-cases, ./analysis

Available skills:
  /analyze-codebase         — QA-focused analysis: routes, models, coverage gaps
  /create-test-plan         — Generate test plan from ticket + code analysis
  /write-test-cases         — Expand test plan into detailed, formatted test cases
  /upload-tests             — Push test cases to {ticketSource.type}
  /setup-e2e-framework      — Scaffold Playwright/Cypress with data factory and prod guards
  /write-e2e-tests          — Generate runnable e2e tests from test cases

Recommended next step:
  /create-test-plan {TICKET-ID}   ← start here for your first ticket
```

If `testFramework.type` was not set, add:
"No e2e framework was configured. Run `/setup-e2e-framework` to scaffold one before using `/write-e2e-tests`."

## Config file handling

If `qa-config.json` does not exist, create it from `qa-config.example.json` first, then update fields.
Use `jq` to read and write individual fields rather than overwriting the entire file.

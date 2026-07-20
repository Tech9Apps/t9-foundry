# Tech9 QA Harness

An AI-powered QA workspace for Claude Code. You open this repo in Claude Code, point it at your ticket tracker and your app repo, and it handles the full testing lifecycle: fetching tickets, analyzing code, writing test plans and test cases, uploading them to your tracker, and generating runnable e2e tests — with hard guardrails that prevent tests from ever running against production.

> **Two repos, not one.** This repo is the QA workspace. Your application lives in a separate repo. You run Claude Code *here*, and the harness reads and writes *there*.

> **Want to see it in action first?** The [`examples/`](examples/) folder has a demo ticket and pre-generated outputs — no Jira or ticket system needed. Follow [`examples/README.md`](examples/README.md) to run the full workflow in ~15 minutes.

---

## Before You Begin

### 1. Install Claude Code

Claude Code is the AI CLI this harness runs inside.

→ Install at **[claude.ai/code](https://claude.ai/code)**

After installing, verify it works:
```bash
claude --version
```

### 2. Install jq

Used by the production-safety hooks to parse config files.

```bash
brew install jq          # macOS
sudo apt install jq      # Ubuntu / Debian
```

### 3. Set up your ticket source

Depending on what ticket tracker your team uses, you'll need one of these before running `/init`:

| Ticket source | What you need | How to get it |
|--------------|---------------|---------------|
| **Jira** | Atlassian MCP connected | Sign in at claude.ai → Integrations → Atlassian |
| **Azure DevOps** | `AZURE_DEVOPS_PAT` in your shell | Azure DevOps → User settings → Personal access tokens (scope: Work Items, Read & write) |
| **ClickUp** | `CLICKUP_TOKEN` in your shell | ClickUp → Profile → Apps → API Token |
| **GitHub Issues** | `gh` CLI authenticated | `brew install gh && gh auth login` |
| **GitLab Issues** | `GITLAB_TOKEN` in your shell | GitLab → Preferences → Access Tokens (scope: `api`) |
| **Bitbucket** | `BITBUCKET_TOKEN` in your shell | Bitbucket → Personal Settings → App passwords |
| **None** | Nothing | `/init` will collect requirements directly |

**To add a token to your shell profile** (so it persists across terminal sessions):
```bash
echo 'export CLICKUP_TOKEN=your_token_here' >> ~/.zshrc
source ~/.zshrc
```

Replace `CLICKUP_TOKEN` with the relevant variable name and `~/.zshrc` with `~/.bashrc` if you use bash.

---

## Setup (Step by Step)

### Step 1 — Clone this repo

```bash
git clone https://github.com/jgifford78/tech9foundry.git
cd tech9foundry
```

Keep this in its own directory, separate from your application repo. For example:
```
~/projects/
  tech9foundry/    ← this repo (the QA workspace)
  my-app/          ← your application repo
```

### Step 2 — Open the workspace in Claude Code

```bash
claude
```

This opens an AI session with all the QA skills pre-loaded. You'll see a welcome prompt — the harness is ready.

### Step 3 — Run `/init`

```
/init
```

The setup wizard asks **7 questions, one at a time**:

1. **Ticket system** — Jira, Azure DevOps, ClickUp, GitHub Issues, GitLab, Bitbucket, or none
2. **App repo location** — local path to your app clone, remote repo identifier, or both
3. **Application type** — web SPA, REST API, full-stack monolith, microservices, GraphQL
4. **Tech stack** — describe what you know (e.g., "React + Node.js" or "Python/FastAPI")
5. **Test framework** — Playwright, Cypress, pytest, RSpec, or "not yet"
6. **Sensitive data** — PII, financial, healthcare, auth secrets, or none
7. **Team size** — solo through large team

After the 7 questions, `/init`:
- Displays a **security testing checklist** tailored to your stack and data sensitivity
- Displays a **performance testing checklist** based on your app type
- Runs a **connectivity check** for your ticket source
- Creates `qa-config.json` with all your project settings
- Validates the config and confirms the setup is complete

`qa-config.json` is gitignored — it stays on your machine only.

**Already have a teammate's config?** Skip the wizard — run `/switch-project <name>` to load a saved profile from `projects/` instead (validated against the schema and the prod-URL guard before it becomes active). Use `/save-project <name>` to share your own setup with the team once it's dialed in.

### Step 4 — (Optional) Scaffold your e2e framework

```
/setup-e2e-framework
```

Run this if you want generated tests that actually execute against your staging environment. It copies framework templates (Playwright, Cypress, pytest, or RSpec) into your app repo with production guards and a data factory pre-wired.

Skip this step if you only need test plans and test cases.

---

## Your First Test Cycle

Once the workspace is set up, the typical workflow for a ticket is:

```
/create-test-plan JIRA-123
```
Fetches the ticket from your tracker, analyzes the relevant code in your app repo, and produces a structured test plan. *(Auto-runs `/analyze-codebase` if needed.)*

```
/write-test-cases JIRA-123
```
Expands the test plan into individual, formatted test cases (happy path, negative, boundary, regression). Saves markdown and JSON files to `./test-cases/`.

```
/upload-tests JIRA-123
```
Pushes the test cases to your ticket tracker — creates linked sub-issues in Jira, tasks in ClickUp, or labeled issues in GitHub.

```
/write-e2e-tests JIRA-123
```
Generates runnable e2e test files in your app repo, using the test cases as the source of truth.

```
/run-tests
```
Executes the test suite against your staging environment and reports a pass/fail summary.

**Faster path for Jira, Azure DevOps, ClickUp, or GitHub Issues tickets:**
```
/generate-tests JIRA-123
```
Runs fetch → analyze → generate manual + automated test cases → review gate → upload → execute → report results as one pipeline, with the ticket fetch and code analysis running in parallel. Same production guards and human-review-before-upload gate as the step-by-step flow above — just fewer commands to type. Falls back to the step-by-step commands above for GitLab/Bitbucket tickets or when you want manual review between each stage.

---

## Skills Reference

| Skill | What it does |
|-------|-------------|
| `/init` | Guided workspace setup — configures everything in one session |
| `/analyze-codebase [TICKET-ID]` | QA-focused code analysis: routes, models, coverage gaps |
| `/create-test-plan TICKET-ID` | Generate structured test plan from ticket + code |
| `/write-test-cases TICKET-ID` | Expand test plan into detailed, formatted test cases |
| `/upload-tests TICKET-ID` | Push test cases to your ticket tracker |
| `/setup-e2e-framework` | Scaffold Playwright / Cypress / pytest / RSpec in your app repo |
| `/write-e2e-tests TICKET-ID` | Generate runnable e2e tests from test cases |
| `/run-tests` | Execute the test suite against staging and report results |
| `/setup-ci` | Generate or extend a CI workflow (GitHub Actions, GitLab CI, Bitbucket) |
| `/catchup-e2e` | Audit existing e2e coverage, find gaps, and generate tests — no ticket required |
| `/reconfigure` | Update a single config value (staging URL, ticket source, framework, etc.) |
| `/connect-tickets` | Reconfigure ticket source only |
| `/connect-repo` | Reconfigure code repository only |
| `/troubleshoot` | Diagnose harness issues — config, connectivity, prod guard conflicts |
| `/switch-project NAME` | Switch the active project to a saved profile under `projects/` |
| `/save-project NAME` | Snapshot the current config as a shared team profile |
| `/generate-regression-pack MODULE` | Build/update a full regression suite for a module — no ticket required |
| `/file-bug FAILURE` | Reproduce a failure on staging and file a bug in the configured tracker |

**Canonical workflow:**
```
/init → /analyze-codebase → /create-test-plan → /write-test-cases → /upload-tests
/init → /analyze-codebase → /setup-e2e-framework → /write-e2e-tests → /setup-ci → /run-tests
/init → /catchup-e2e → /setup-ci → /run-tests   ← for existing projects without tickets
```

**Fast path (Jira / Azure DevOps / ClickUp / GitHub Issues, ticket-driven):** `/generate-tests TICKET-ID` runs the same fetch → analyze → generate → upload → execute pipeline as one command, via subagents that fetch the ticket and analyze code in parallel. Built from smaller pieces in `.claude/commands/` (`fetch-ticket`, `analyze-code`, `create-manual-test-cases`, `create-automated-test-cases`, `post-tests`, `run-spec-tests`) composed by agents in `.claude/agents/`. Use this when you want speed on a supported source; use the step-by-step skills above for GitLab/Bitbucket, other e2e frameworks, or when you want to review between stages.

---

## Production Safety

This harness uses **5 independent layers** to prevent tests from running against production:

1. **CLAUDE.md behavioral rule** — Claude refuses to target production
2. **Session startup hook** — validates your staging URL is not production on every session start
3. **Bash hook** — scans every shell command for production env vars and URL patterns
4. **File write hook** — scans every file being written for hardcoded production URLs
5. **Framework runtime guard** — e2e framework templates abort at startup if `BASE_URL` matches a production pattern

Any single layer independently blocks production execution. See [`docs/prod-safety.md`](docs/prod-safety.md) for a full explanation of each layer.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| "Your workspace is not configured" | `qa-config.json` is missing | Run `/init` |
| Hook blocks your staging URL | Staging URL accidentally matches a prod pattern | Run `/troubleshoot` to identify the conflicting pattern; use `/reconfigure` to fix it |
| Jira fetch fails with an MCP error | Atlassian MCP not connected | claude.ai → Integrations → Atlassian → reconnect |
| Azure DevOps returns 401/403 | `AZURE_DEVOPS_PAT` not set, expired, or missing Work Items scope | Regenerate the PAT with Work Items Read & write, `export AZURE_DEVOPS_PAT=...`, restart your terminal |
| ClickUp returns 401 | `CLICKUP_TOKEN` not set or expired | `export CLICKUP_TOKEN=...` then restart your terminal |
| GitLab / Bitbucket returns 403 | Token missing or lacks required scope | Check the token permissions — GitLab needs `api` scope, Bitbucket needs `issues:read` + `issues:write` |
| e2e tests abort with "PRODUCTION ENVIRONMENT DETECTED" | `BASE_URL` or `testEnvironmentBaseUrl` points to production | Check `qa-config.json > environments.testEnvironmentBaseUrl` |
| `/init` stops after one question | Normal behavior — it asks one question at a time | Answer and press Enter to continue |
| Test cases saved but not uploaded | `/upload-tests` was not run | Run `/upload-tests TICKET-ID` |

Run `/troubleshoot` for a guided diagnostic that checks config validity, ticket source connectivity, and framework setup in one pass.

---

## Configuration

`/init` creates `qa-config.json` automatically. To inspect the full schema or configure manually:

```bash
cp qa-config.example.json qa-config.json
```

Key fields:

| Field | What to set |
|-------|-------------|
| `project.name` | Your project name |
| `ticketSource.type` | `jira`, `azure`, `clickup`, `github`, `gitlab`, `bitbucket`, or `none` |
| `codeRepository.localPath` | Path to your local app repo clone |
| `environments.testEnvironmentBaseUrl` | Your **staging** URL — never production |
| `productionProtection.prodUrlPatterns` | Regex patterns matching your production URLs |
| `testFramework.type` | `playwright`, `cypress`, `pytest`, `rspec`, `webdriverio`, or `jest` |

Use `/reconfigure` to update any single value after initial setup.

See [`docs/integration-guide.md`](docs/integration-guide.md) for per-source setup instructions.

---

## Directory Structure

```
.
├── CLAUDE.md                   # AI behavioral instructions (read by Claude on every session)
├── qa-config.json              # Your project config (gitignored — created by /init)
├── qa-config.example.json      # Template to copy from
├── qa-config.schema.json       # Config validation schema
├── .claude/
│   ├── settings.json           # Hook wiring and permissions
│   ├── skills/                 # Step-by-step slash command definitions
│   ├── commands/                # Ticket-driven fast-path pipeline steps (ticket-source-agnostic)
│   ├── agents/                  # Subagents that compose commands/ into pipelines
│   ├── guides/                  # Reference docs imported into CLAUDE.md
│   └── memory/                  # Binding AI-usage rules for test-case work
├── hooks/                      # Production safety shell scripts
│   ├── session-init.sh         # Runs on session start
│   ├── prod-guard.sh           # Runs before every shell command
│   └── env-detector.sh         # Runs before every file write
├── templates/
│   └── e2e/                    # Playwright, Cypress, pytest, RSpec scaffolds
├── scripts/
│   └── check-prereqs.sh        # Verify your environment
├── projects/                    # Saved team config profiles (/switch-project, /save-project)
└── docs/
    ├── integration-guide.md    # Per-source setup instructions
    ├── prod-safety.md          # Production safety layer details
    └── e2e-patterns.md         # Page object, data factory, teardown patterns
```

---

## Supported Integrations

| Category | Supported |
|----------|-----------|
| Ticket sources | Jira, Azure DevOps, ClickUp, GitHub Issues, GitLab Issues, Bitbucket |
| Code repositories | GitHub, GitLab, Bitbucket, local filesystem |
| Test case upload | Jira, Azure DevOps, ClickUp, GitHub Issues |
| E2e frameworks | Playwright, Cypress, pytest, RSpec, WebDriverIO |
| App tech stacks | Node.js, Python, Ruby, Java, Go — framework agnostic |

---

## For Developers

No build step — this is a pure bash/markdown/JSON project.

```bash
bash scripts/check-prereqs.sh   # check tool prerequisites
bash tests/run-tests.sh         # run the full test suite (requires bats-core, jq, node)
```

See [`docs/`](docs/) for architecture details.

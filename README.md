# Tech9 QA Harness

An AI-powered QA workspace for Claude Code. Helps QA engineers go from a ticket to a complete, uploaded test plan and a runnable e2e test suite — with hard guardrails that prevent tests from ever running against production.

## What It Does

| Capability | Skill |
|-----------|-------|
| Guided workspace setup (one command) | `/init` |
| Reconfigure ticket source | `/connect-tickets` |
| Reconfigure code repository | `/connect-repo` |
| Analyze codebase for QA context | `/analyze-codebase [TICKET-ID]` |
| Generate a structured test plan | `/create-test-plan TICKET-ID` |
| Write individual test cases | `/write-test-cases TICKET-ID` |
| Upload test cases to your tracker | `/upload-tests TICKET-ID` |
| Scaffold Playwright / Cypress / Selenium / WebDriverIO | `/setup-e2e-framework` |
| Write e2e tests for a feature | `/write-e2e-tests TICKET-ID` |

## Prerequisites

Run the check script to verify your environment:

```bash
bash scripts/check-prereqs.sh
```

Required:
- **Claude Code** — [Install](https://claude.ai/code)
- **jq** — `brew install jq` (used by production-safety hooks)

Required based on your ticket source:
- **Jira** — Atlassian MCP configured in Claude Code (sign in at claude.ai)
- **ClickUp** — `export CLICKUP_TOKEN=your_token` in your shell profile
- **GitHub Issues / Repos** — `gh` CLI: `brew install gh && gh auth login`
- **GitLab** — `export GITLAB_TOKEN=your_pat` in your shell profile
- **Bitbucket** — `export BITBUCKET_TOKEN=your_app_password` in your shell profile

Required based on your e2e framework:
- **Playwright** — `npm install -D @playwright/test` in your app repo
- **Cypress** — `npm install -D cypress` in your app repo

## Quick Start (under 30 minutes)

### 1. Open this workspace in Claude Code

```bash
cd ~/qa-workspace   # wherever you cloned this repo
claude
```

### 2. Run `/init`

```
/init
```

The setup wizard asks about your project in one block of questions, then:
- Generates a security and performance checklist tailored to your stack
- Configures your ticket source (Jira, ClickUp, GitHub Issues, GitLab, Bitbucket, or none)
- Configures your code repository and staging environment URL
- Writes `qa-config.json` and validates it

To reconfigure a single piece later, run `/connect-tickets` or `/connect-repo` individually.

### 3. (Optional) Scaffold your e2e framework

```
/setup-e2e-framework
```

Copies the framework template into your app repo with production guards and a data factory pattern pre-wired.

### 4. Start working on a ticket

```
/create-test-plan JIRA-123
```

This fetches the ticket, analyzes the relevant code, and produces a test plan. From there:

```
/write-test-cases JIRA-123
/upload-tests JIRA-123
/write-e2e-tests JIRA-123
```

## Configuration

`/init` creates `qa-config.json` for you. To configure manually or inspect the full schema, copy the example:

```bash
cp qa-config.example.json qa-config.json
```

`qa-config.json` is gitignored — it contains your project-specific paths and URLs. The most important fields:

| Field | What to set |
|-------|-------------|
| `ticketSource.type` | `jira`, `clickup`, or `github` |
| `codeRepository.localPath` | Path to your local app repo clone |
| `environments.testEnvironmentBaseUrl` | Your **staging** URL (NOT production) |
| `productionProtection.prodUrlPatterns` | Regex patterns for your production URLs |

## Production Safety

This harness uses **5 independent layers** to prevent tests from running against production:

1. **CLAUDE.md behavioral rule** — Claude refuses to target production
2. **Session startup hook** — validates staging URL is not prod on every session start
3. **Bash hook** — scans every shell command for production URL patterns
4. **File write hook** — scans every file being written for production URLs
5. **Framework runtime guard** — e2e framework templates crash at startup if `BASE_URL` matches a prod pattern

Any single layer independently blocks production execution. See `docs/prod-safety.md` for full details.

## Directory Structure

```
.
├── CLAUDE.md                   # AI behavioral instructions
├── qa-config.json              # Your project config (gitignored)
├── qa-config.example.json      # Template to copy from
├── .claude/
│   ├── settings.json           # Hooks and permissions
│   └── skills/                 # Custom slash commands
├── hooks/                      # Production safety shell scripts
├── templates/
│   └── e2e/                    # Playwright, Cypress, Selenium, WebDriverIO
├── scripts/
│   └── check-prereqs.sh
└── docs/
    ├── integration-guide.md
    ├── prod-safety.md
    └── e2e-patterns.md
```

## Supported Integrations

| Category | Supported |
|----------|-----------|
| Ticket sources | Jira, ClickUp, GitHub Issues, GitLab Issues, Bitbucket |
| Code repositories | GitHub, GitLab, Bitbucket, local filesystem |
| Test case upload | Jira, ClickUp, GitHub Issues |
| E2e frameworks | Playwright, Cypress, Selenium, WebDriverIO |
| App tech stacks | Node.js, Python, Ruby, Java, Go — framework agnostic |

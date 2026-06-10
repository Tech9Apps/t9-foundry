# Tech9 QA Harness

An AI-powered QA workspace for Claude Code. Helps QA engineers go from a ticket to a complete, uploaded test plan and a runnable e2e test suite — with hard guardrails that prevent tests from ever running against production.

## What It Does

| Capability | Skill |
|-----------|-------|
| Connect to Jira, ClickUp, or GitHub Issues | `/connect-tickets` |
| Connect to GitHub, GitLab, or Bitbucket | `/connect-repo` |
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

### 2. Configure your ticket source

```
/connect-tickets
```

Claude will ask which ticket system you use, test connectivity, and write your configuration.

### 3. Configure your code repository

```
/connect-repo
```

Claude will ask for your repo details and your **staging/test environment URL**. It validates that the URL is not production before saving.

### 4. (Optional) Scaffold your e2e framework

```
/setup-e2e-framework
```

Copies the framework template into your app repo with production guards and a data factory pattern pre-wired.

### 5. Start working on a ticket

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

Copy the example config and fill in your values:

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

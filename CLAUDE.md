# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## QA Engineer AI Harness

You are an AI assistant for QA engineers. Your purpose is to help with the full software testing lifecycle: analyzing tickets and code, creating test plans, writing test cases, uploading them to project management tools, and building e2e test suites. This is not a general-purpose coding workspace.

---

## Config Contract

**Always read `qa-config.json` before starting any task.**

If it does not exist, stop and say:
> "Your workspace is not configured. Run `/init` to set up this workspace — it asks about your project and configures everything in one guided session, or run `/switch-project <profile>` if your team already has a saved profile under `projects/`. (Or run `/connect-tickets` then `/connect-repo` individually to configure manually.)"

`qa-config.json` is gitignored. When creating it for the first time, copy `qa-config.example.json` as the starting template, then update fields. Validate against `qa-config.schema.json` (required top-level keys: `project`, `ticketSource`, `codeRepository`, `environments`, `productionProtection`).

If it exists but is missing required fields for the current task, prompt the engineer to run the relevant setup skill first.

**One carve-out:** `Manual-test-generator`'s inline mode — a Jira key plus a local codebase path in the same message — runs without `qa-config.json`, deriving the project context from the message (see that agent's Step 0). It is manual-only and never executes a test against any environment, so the project-specific production-URL layer it skips is not in play; every other task, and any automated-test generation or execution, still requires the config.

### Project profiles (multi-project support)

The committed `projects/` directory holds one config per project, same shape as `qa-config.json` (see `projects/example.json`). Profiles never contain literal secrets — tokens are env-var *names* only.

- `/switch-project <name>` — validates `projects/<name>.json` (schema + prod-URL guard) and copies it to `qa-config.json`, making it the active project. With no argument it lists available profiles.
- `/save-project <name>` — snapshots the current `qa-config.json` into `projects/<name>.json` (after a secrets scan) so teammates can reuse it.

The active project is always whatever `qa-config.json` currently holds — all skills, commands, agents, and hooks read from it; none hardcode project values.

---

## PRODUCTION ENVIRONMENT PROHIBITION — ABSOLUTE RULE

**Tests must NEVER run against production environments. This rule has no exceptions.**

Production indicators:
- URLs matching `qa-config.json > productionProtection.prodUrlPatterns`
- URLs containing `prod`, `production`, or `live` without a `staging`, `test`, `dev`, or `qa` qualifier
- `NODE_ENV=production`, `RAILS_ENV=production`, `APP_ENV=prod`, `DJANGO_ENV=production`, `--env=prod`, `--environment=production`
- Database connection strings pointing to production hosts

If anything targets production:
1. **STOP immediately** — do not generate or execute the action
2. Identify the specific production indicator
3. Explain the violation clearly
4. Suggest the correct staging environment from `qa-config.json`

The hooks and framework templates enforce this at additional layers — your behavioral compliance is Layer 1.

---

## Skills

| Skill | Purpose |
|-------|---------|
| `/init` | Guided workspace setup — project questions, security checklist, full configuration |
| `/connect-tickets` | Configure ticket source (Jira, ClickUp, GitHub Issues, GitLab, Bitbucket, or none) |
| `/connect-repo` | Configure code repository and staging environment URL |
| `/analyze-codebase [TICKET-ID]` | QA-focused codebase analysis — routes, models, coverage gaps |
| `/create-test-plan TICKET-ID` | Generate structured test plan from ticket + code analysis |
| `/write-test-cases TICKET-ID` | Expand test plan into detailed, formatted test cases |
| `/upload-tests TICKET-ID` | Push test cases to configured ticket system |
| `/setup-e2e-framework` | Scaffold e2e framework with data factory and production guards |
| `/write-e2e-tests TICKET-ID` | Generate runnable e2e tests from test cases and codebase analysis |
| `/reconfigure` | Update a single config value (staging URL, ticket source, framework, prod patterns, etc.) |
| `/run-tests` | Execute the configured test suite against staging and report pass/fail results |
| `/setup-ci` | Generate or extend a CI workflow to run e2e tests on push/PR |
| `/catchup-e2e` | Audit existing e2e coverage, find gaps, and generate tests — no ticket required |
| `/troubleshoot` | Diagnose harness issues — config validity, ticket source connectivity, prod guard conflicts |
| `/switch-project NAME` | Switch the active project — validates and copies `projects/NAME.json` to `qa-config.json` |
| `/save-project NAME` | Snapshot the current `qa-config.json` as a shared team profile in `projects/` |
| `/generate-regression-pack MODULE` | Build/update a full regression suite (manual + Playwright) for a module — no ticket required |
| `/file-bug FAILURE` | Reproduce a failure on staging, capture evidence, and file a bug in the configured tracker |

### Canonical Workflow
```
/init → /analyze-codebase → /create-test-plan → /write-test-cases → /upload-tests
/init → /analyze-codebase → /setup-e2e-framework → /write-e2e-tests → /setup-ci → /run-tests
/init → /catchup-e2e → /setup-ci → /run-tests   ← for existing projects
```

`/init` runs ticket source and repo configuration inline. Run `/connect-tickets` or `/connect-repo` individually to reconfigure a single piece. Use `/reconfigure` to update any single config value after initial setup.

`/create-test-plan` auto-triggers `/analyze-codebase` if analysis is missing or older than 7 days.

If something isn't working, run `/troubleshoot` for a guided diagnostic.

---

## Development

No build step — this is a pure bash/markdown/JSON project.

**Run the full test suite** (requires `bats-core`, `jq`, `node`):
```bash
bash tests/run-tests.sh
```

**Run a single test file:**
```bash
bats tests/prod-guard.bats
bats tests/env-detector.bats
bats tests/session-init.bats
bats tests/schema-validation.bats
bats tests/wording-lint.bats
bats tests/check-prereqs.bats
bats tests/preflight.bats
bats tests/layer5-guard.bats        # TS guards; needs Node >= 22.6 (type stripping)
bats tests/layer5-guard-py-rb.bats  # pytest/selenium/rspec guards; needs python3 + ruby
```

**Run a single test by name pattern:**
```bash
bats tests/prod-guard.bats --filter "blocks NODE_ENV"
```

**Install test dependencies (ajv for schema validation):**
```bash
npm install --prefix tests/
```

**Check tool prerequisites:**
```bash
bash scripts/check-prereqs.sh
```

**Preflight an autonomous run** (go/no-go on config, credentials, prod patterns, staging reachability):
```bash
QA_AUTONOMOUS=1 bash scripts/preflight.sh
```

---

## Architecture

The harness has no runtime of its own — it is a set of instructions and scripts that Claude Code executes as behavior. All runtime behavior flows through `qa-config.json` (gitignored; validated against `qa-config.schema.json`).

### Core components

**`.claude/skills/*.md`** — Each skill is a markdown file. Claude reads the file and executes its instructions when a trigger phrase matches. Skills reference `qa-config.json` for project-specific values. There is no "call skill and return" mechanism — multi-step flows inline the logic from multiple skills.

To add a skill: create `.claude/skills/{name}.md` with a `## When to invoke` section listing trigger phrases and a `## Steps` section with numbered instructions. The trigger phrases are matched by Claude behaviorally — there is no registration step. When one skill needs to run another's logic, it reads and inlines the target file's steps directly.

**`.claude/commands/*.md` + `.claude/agents/*.md`** — the ticket-driven fast path for Jira/Azure DevOps/ClickUp/GitHub Issues/no-ticket-system. Commands are formally-registered slash commands (visible via the `Skill` tool), each covering one pipeline step (`fetch-ticket`, `analyze-code`, `create-manual-test-cases`, `create-automated-test-cases`, `post-tests`, `run-spec-tests`). Subagents (`Manual-test-generator`, `Manual-Automation-test-generator`, `Bug-reporter`, `Regression-pack-generator`) compose these steps into a pipeline: each step is "read the command file, execute its instructions, carry a checkpoint forward." This path runs fetch-ticket and analyze-code as parallel agents and isolates heavy read work in subagent context, so it is the faster option for the sources it covers. Per-ticket-source branching lives *inside* `fetch-ticket.md`/`post-tests.md` (one file, branch on `ticketSource.type`) — do not reintroduce per-source files (`fetch-jira-ticket.md` etc.); that pattern was consolidated on 2026-07-17 because it triplicated ~90% identical boilerplate across sources.

This path is intentionally narrower than `.claude/skills/*.md`, which remains authoritative for: initial workspace setup/scaffolding (`/init`, `/connect-tickets`, `/connect-repo`, `/setup-e2e-framework`, `/setup-ci`), the structured test-plan artifact stage (`/create-test-plan`), multi-format test-case output (Gherkin/Robot Framework/ClickUp-checklist via `/write-test-cases`), multi-framework e2e authoring/execution (Cypress/pytest/RSpec/Jest/WebDriverIO via `/write-e2e-tests`/`/run-tests`), and GitLab/Bitbucket ticket + code access. Adding a ticket source to the commands path means updating both `.claude/guides/integration-sources.md` and the branches in `fetch-ticket.md`/`post-tests.md`.

**`.claude/guides/*.md`** — Reference content imported into `CLAUDE.md` at runtime via `@filename` syntax (e.g., `@.claude/guides/integration-sources.md`). Guides cover: ticket source APIs, e2e authoring standards, and output path conventions.

**`hooks/`** — Three bash scripts wired to Claude tool-use events in `.claude/settings.json`:

| Hook | Event | Purpose |
|------|-------|---------|
| `session-init.sh` | SessionStart | Validates `qa-config.json` exists; blocks if `testEnvironmentBaseUrl` matches a prod pattern |
| `prod-guard.sh` | PreToolUse Bash | Scans every shell command for production env vars and URLs |
| `env-detector.sh` | PreToolUse Write\|Edit\|MultiEdit | Scans file content being written for production URLs and env var assignments |

Hook contract: reads JSON from stdin. `exit 0` = allow. `exit 2` = block; stdout message is surfaced to Claude as the reason.

**`templates/e2e/{framework}/`** — Scaffold files (playwright, cypress, selenium, webdriverio, pytest, rspec) copied into the user's app repo by `/setup-e2e-framework`. Each includes a Layer 5 production guard that runs before any test executes. TS templates (playwright, cypress, webdriverio) locate `qa-config.json` via `QA_HARNESS_DIR` (set in `.env.test`) since the harness and app repo are normally sibling directories, not nested.

**`templates/test-plan-template.md`** — Structure used by `/create-test-plan` to generate consistent test plans.

**`templates/test-case-formats.md`** — Format reference (Jira-style, BDD/Gherkin, ClickUp, Robot Framework, plain markdown) used by `/write-test-cases`.

**`docs/`** — Developer-facing reference for this harness:

| File | Content |
|------|---------|
| `docs/prod-safety.md` | Detailed explanation of all 5 production safety layers |
| `docs/integration-guide.md` | End-user setup instructions for each ticket source (mirrors `.claude/guides/integration-sources.md`) |
| `docs/e2e-patterns.md` | Page object model, data factory, and teardown patterns |

### 5-layer production safety

Each guard has two modes: `warn` (default; heuristic matches only warn) and `enforce` (heuristic matches block; selected by `QA_AUTONOMOUS=1` or `productionProtection.mode`). See `docs/prod-safety.md#guard-modes-warn-and-enforce`. Shared bash helpers live in `hooks/lib/` (`qa-config-path.sh`, `guard-mode.sh`).

Each layer independently prevents production execution: (1) CLAUDE.md behavioral rule, (2) `session-init.sh` startup validation, (3) `prod-guard.sh` bash command scan, (4) `env-detector.sh` file content scan, (5) framework global-setup runtime guard.

### bash 3.2 compatibility (macOS default shell)

All hooks must be compatible with bash 3.2. Known pitfalls:

- **No `mapfile`** — use `while IFS= read -r line; do [ -n "$line" ] && arr+=("$line"); done < <(cmd)`
- **No `\s` in extended regex** — use `[[:space:]]` instead
- **Empty array `[@]` expansion triggers "unbound variable" with `set -u`** — guard with `if [ "${#arr[@]}" -gt 0 ]; then`
- **`grep -E "$pattern"` fails when pattern starts with `--`** — always use `grep -E -e "$pattern"`

---

---

## Test-Case Rules (Memory)

`.claude/memory/` holds binding rules for any task that creates, edits, runs, or
uploads **manual or automated test cases**. Read `ai-usage-rules.md` at the
start of every such task, then the manual or automated file as appropriate.
These rules have the same authority as this file.

@.claude/guides/integration-sources.md
@.claude/guides/e2e-practices.md
@.claude/guides/output-conventions.md
@.claude/memory/ai-usage-rules.md
@.claude/memory/manual-test-rules.md
@.claude/memory/automated-test-rules.md

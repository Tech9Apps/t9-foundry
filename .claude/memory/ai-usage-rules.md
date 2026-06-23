# AI Usage Rules — All Test-Case Work

Apply these to **every** task that generates, edits, runs, or uploads test
cases. Read this before doing anything else.

## 1. Ground every test in a real source of truth
- Start from the actual requirement: the Jira ticket (via Atlassian MCP), the
  ticket described by the engineer, or `qa-config.json` if configured. Never
  invent acceptance criteria.
- Read the relevant application source code before writing tests. Tests must
  reflect what the code actually does — routes, validations, states, error
  paths — not what the ticket title implies.
- If the ticket and the code disagree, **stop and surface the conflict** to the
  engineer. Do not silently pick one.

## 2. Never run tests against production — absolute rule
- This mirrors the PRODUCTION ENVIRONMENT PROHIBITION in `CLAUDE.md`. It has no
  exceptions.
- Production indicators: URLs matching `productionProtection.prodUrlPatterns`;
  URLs containing `prod`/`production`/`live` without a `staging`/`test`/`dev`/`qa`
  qualifier; environment flags set to the production value (e.g. a `NODE_ENV`,
  `RAILS_ENV`, `APP_ENV`, or `DJANGO_ENV` pointed at prod, or a `--env` flag
  naming prod); database connection strings pointing at a production host.
- On any production indicator: STOP, name the indicator, explain the violation,
  point to the correct staging environment, and do not generate or run the
  action.

## 3. Human review gate before anything leaves the workspace
- Before creating Jira issues, posting comments, or uploading test cases to any
  external system, **present the full set of test cases to the engineer and
  wait for explicit approval.**
- The engineer may add, remove, or change cases. Apply all feedback, then
  re-present if it changed materially, before proceeding.
- Treat anything sent to an external service as published — confirm first.

## 4. No secrets, no hardcoded environment values
- Never hardcode URLs, credentials, API keys, tokens, or environment-specific
  IDs in test files or test-case text. Read them from `process.env` / config.
- Never write secrets into files committed to the repo or into Jira.

## 5. Be honest about outcomes
- Report results faithfully. If a test fails, say so with the real output. If a
  step was skipped, say it was skipped. Do not claim a suite passed without
  having run it and seen the result.
- When you are uncertain whether a test is valid, mark it as needs-review rather
  than presenting it as confirmed.

## 6. Stay in scope and follow conventions
- Generate test cases only for the ticket/feature in scope. Do not refactor app
  code or unrelated tests as a side effect.
- Follow the output-path conventions in `.claude/guides/output-conventions.md`
  and the framework rules in `.claude/guides/e2e-practices.md`.
- Match the existing style of test files and test-case documents already in the
  repo — naming, structure, format.

## 7. Make work reproducible and reviewable
- Save generated artifacts to the configured output directories so they can be
  reviewed and version-controlled.
- Each test case should be traceable back to its ticket ID and the acceptance
  criterion it covers.

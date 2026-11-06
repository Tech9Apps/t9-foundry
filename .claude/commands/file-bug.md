# File a Bug Report

You are given a failure to report: **$ARGUMENTS** — a failure description, a failed spec file name, or a pasted error/stack trace.

**If `$ARGUMENTS` is empty, blank, or not provided, stop immediately and tell the user:**
> "Describe the failure to report. Usage: `/file-bug <description | spec-file | pasted error>` (e.g. `/file-bug checkout total is wrong when a coupon is applied` or `/file-bug checkout.spec.ts`)"
**Do not proceed with any further steps.**

## Prerequisites

Read `qa-config.json` first:
- **Ticket source**: `ticketSource.type` — determines where the bug is filed
- **Test environment**: `environments.testEnvironmentBaseUrl` — the ONLY environment you may touch
- **Output dir**: `testOutput.testCasesDir`

If `qa-config.json` is missing, stop and tell the user to run `/init` or `/switch-project <profile>` first.

**PRODUCTION PROHIBITION — ABSOLUTE.** Reproduction happens against `environments.testEnvironmentBaseUrl` only. If the failure was observed on production, reproduce it on staging — never touch the production URL.

## Reproduce the Failure

1. **If `$ARGUMENTS` is a spec file**: find it under `tests/` (same resolution as `run-spec-tests.md`) and run it headed against staging. Read the failure output, screenshots, and traces from `test-results/`.
2. **If `$ARGUMENTS` is a description or pasted error**: work out the affected flow (search the app source under `codeRepository.localPath` if needed), then reproduce manually via a short Playwright script or the existing page objects against staging. Capture a screenshot of the failing state where possible.
3. Record the **exact reproduction steps** you performed, the **expected** behavior (from code, existing test cases, or the user's description), and the **actual** behavior observed.

**If you cannot reproduce the failure**, say so plainly and ask the user for more detail — do not file a bug claiming a reproduction you didn't observe (honesty rules in `.claude/memory/ai-usage-rules.md` §5 apply).

## Draft the Bug Report

Build a structured report:

- **Title** — concise, symptom-first (e.g. "Checkout total ignores coupon discount on payment step")
- **Environment** — staging URL (from config), browser, build/commit if known
- **Steps to Reproduce** — numbered, one action per step
- **Expected Result** / **Actual Result**
- **Evidence** — screenshot/trace paths, error output, relevant log lines
- **Severity/Priority** — proposed, with one-line justification
- **Suspected Area** — source files/modules implicated (if the code scan found any)

## Review Gate — Human Approval Required

Present the full draft bug report to the user and ask:

> **Please review the bug report above.** You can:
> - **Approve** — type `yes` or `approve` to file it
> - **Update** — tell me what to change (title, severity, steps, etc.)
>
> What would you like to do?

**Wait for the user's response. Do NOT file anything until they explicitly approve.** Apply any feedback and re-present until approved.

## File the Bug

Branch on `ticketSource.type`. **Every `curl` call below uses `-f` (fail on HTTP error status) and `--max-time 30` (bound the wait) — check the exit code after each one. A non-zero exit means the call failed: do not treat it as success, do not proceed to "Save the Receipt" below, and tell the user what failed (status/error body if `-f`'s stderr captured one) instead of silently claiming the bug was filed.**

### Jira
Use `mcp__claude_ai_Atlassian__createJiraIssue`:
- `cloudId`: `ticketSource.jira.cloudId`
- `projectKey`: `ticketSource.jira.projectKey`
- `issueTypeName`: `Bug`
- `summary`: the bug title
- `description`: the full report body (markdown)

### Azure DevOps
Create a **Bug** work item (config from `ticketSource.azure`, PAT from its `tokenEnvVar`):
```bash
curl -fsS --max-time 30 -X POST -u ":$AZURE_DEVOPS_PAT" \
  -H "Content-Type: application/json-patch+json" \
  -d '[
    {"op": "add", "path": "/fields/System.Title", "value": "<bug title>"},
    {"op": "add", "path": "/fields/Microsoft.VSTS.TCM.ReproSteps", "value": "<steps + expected/actual as HTML>"},
    {"op": "add", "path": "/fields/Microsoft.VSTS.Common.Priority", "value": <priority-number>}
  ]' \
  "{host}/{organization}/{project}/_apis/wit/workitems/\$Bug?api-version=7.1"
```

### ClickUp
Create a task in the configured list (token from `ticketSource.clickup.tokenEnvVar`):
```bash
curl -fsS --max-time 30 -X POST -H "Authorization: $CLICKUP_TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "[BUG] <bug title>", "description": "<full report body>", "priority": <priority_num>}' \
  "https://api.clickup.com/api/v2/list/{listId}/task"
```

### GitHub
Create an issue in the configured repo (`ticketSource.github.repo`, owner/repo format):
```bash
gh issue create --repo {ticketSource.github.repo} \
  --title "[BUG] <bug title>" \
  --body "<full report body>" \
  --label bug
```
`gh` exits non-zero on failure the same way — check its exit code before proceeding, same as the `curl` calls above.

### GitLab
Create an issue in the configured project (`ticketSource.gitlab.projectId`, host defaults to `https://gitlab.com`, token from `ticketSource.gitlab.tokenEnvVar` default `GITLAB_TOKEN`):
```bash
curl -fsS --max-time 30 -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  --data-urlencode "title=[BUG] <bug title>" \
  --data-urlencode "description=<full report body>" \
  --data-urlencode "labels=bug" \
  "{host}/api/v4/projects/{projectId}/issues"
```

### Bitbucket
Create an issue in the configured repo (`ticketSource.bitbucket.workspace`/`repo`, account username from `ticketSource.bitbucket.username`, app password from `ticketSource.bitbucket.tokenEnvVar` default `BITBUCKET_TOKEN`):
```bash
curl -fsS --max-time 30 -X POST -u "{username}:$BITBUCKET_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "[BUG] <bug title>", "content": {"raw": "<full report body>", "markup": "markdown"}}' \
  "https://api.bitbucket.org/2.0/repositories/{workspace}/{repo}/issues"
```
Bitbucket app passwords authenticate as `username:app_password`, so `ticketSource.bitbucket.username` is required. If it is unset, stop and tell the user to set it with `/reconfigure` (or add it to `qa-config.json`) — do not guess it and do not retry with an empty username.

### None
Save the report to `{testCasesDir}/bugs/<slugified-title>.md` and report the path — nothing leaves the workspace.

## Save the Receipt

**Only reachable if the bug was actually created (or, for `none`, saved) in the previous step** — if the create call failed, do not save a receipt at all; report the failure instead.

Save to `{testCasesDir}/bugs/<created-id-or-slug>-receipt.json`:

```json
{
  "title": "...",
  "trackerType": "jira|azure|clickup|github|gitlab|bitbucket|none",
  "createdId": "<issue key / work item id / task id / issue number / file path>",
  "reproduced": true,
  "evidencePaths": []
}
```

`reproduced` must reflect what actually happened in "Reproduce the Failure" above — `false` (not the literal `true` shown in this template) if reproduction failed or was skipped and the user explicitly chose to file anyway.

## Output

- The created bug's key/ID/URL (or the saved file path for `none`)
- Reproduction status (reproduced / not reproduced — filed with user's confirmation)
- Evidence file paths

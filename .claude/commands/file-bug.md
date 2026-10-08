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

## Check for an existing report (github, clickup, azure)

Before the review gate, look for a report of the same defect so the user can decide not to file a duplicate:

```bash
node scripts/tracker/cli.js search --input '{"query":"<2-4 distinctive words from the title>","kind":"bug","limit":5}'
```

`data.items` lists `{ id, title, url, status }`. Show anything that plausibly matches under **Possible existing reports** in the review gate below. If the search itself fails, say so and carry on — a failed search is not a reason to block the report. (Jira, GitLab, Bitbucket and `none` have no adapter yet: skip this step.)

## Review Gate — Human Approval Required

Present the full draft bug report to the user — and, if the search above found candidates, the **Possible existing reports** list — and ask:

> **Please review the bug report above.** You can:
> - **Approve** — type `yes` or `approve` to file it as a new bug
> - **Update** — tell me what to change (title, severity, steps, etc.)
> - **Duplicate** — name an existing report above and I will add this as a comment on it instead (github, clickup, azure)
>
> What would you like to do?

**Wait for the user's response. Do NOT file anything until they explicitly approve.** Apply any feedback and re-present until approved.

## File the Bug

Branch on `ticketSource.type`. `github`, `clickup` and `azure` go through the tracker adapter CLI; `jira` uses the Atlassian MCP tool; `gitlab` and `bitbucket` (no adapter yet) use the `curl` calls below — **those use `-f` (fail on HTTP error status) and `--max-time 30` (bound the wait): check the exit code after each one. A non-zero exit means the call failed: do not treat it as success, do not proceed to "Save the Receipt" below, and tell the user what failed instead of silently claiming the bug was filed.**

### Jira
Use `mcp__claude_ai_Atlassian__createJiraIssue`:
- `cloudId`: `ticketSource.jira.cloudId`
- `projectKey`: `ticketSource.jira.projectKey`
- `issueTypeName`: `Bug`
- `summary`: the bug title
- `description`: the full report body (markdown)

### GitHub / ClickUp / Azure DevOps — via the tracker adapter CLI

1. **Write the input to a file** with the Write tool — never inline a multi-line report into a shell command (quoting breaks, and a bug body is full of quotes and backticks). Use `{testCasesDir}/bugs/<slug>.input.json`, where `<slug>` is the lowercase, hyphenated title (≤ 50 characters):
   ```json
   {
     "title": "<bug title>",
     "body": "<the full report body, markdown>",
     "priority": "High",
     "labels": [],
     "idempotencyKey": "bug-<slug>"
   }
   ```
   `priority` is `High`, `Medium` or `Low` — map the severity you proposed in the draft. The tracker's own prefix/type (`[BUG]`, label, work item type) is added for you.
2. **File it:**
   ```bash
   node scripts/tracker/cli.js create-bug --input-file {testCasesDir}/bugs/<slug>.input.json
   ```
   Credentials come from the environment (`GITHUB_TOKEN`, `CLICKUP_TOKEN`, `AZURE_DEVOPS_PAT`, or `ticketSource.<type>.tokenEnvVar`); never put a token on the command line or in a file.
3. **Read the result.** `{ "ok": true, "data": { "id", "url", "deduplicated" } }` → record `id` as the receipt's `createdId` and show the user the `url`. If `deduplicated` is `true`, the bug **was already filed** by an earlier attempt: say "this was already filed as `<id>`", not "created".
4. **If it fails** (`"ok": false`), branch on `error.code`: `UNAUTHENTICATED` / `FORBIDDEN` / `CONFIG` → tell the user exactly what is missing or wrong (`error.message`) and how to fix it, do not retry; `VALIDATION` → fix the input and retry; `RATE_LIMITED` / `TIMEOUT` / `NETWORK` / `UPSTREAM_ERROR` → run the **same command again**. That is safe: the idempotency key means a retry returns the original bug even when the first attempt succeeded and only the response was lost. Do **not** save a receipt until it succeeds.

**If the user chose "Duplicate"** at the review gate, add the new evidence to the existing report instead of filing a new one:
```bash
node scripts/tracker/cli.js comment --input-file {testCasesDir}/bugs/<slug>.comment.json
```
with `{ "id": "<existing id>", "body": "<what this run adds: steps, evidence, environment>", "idempotencyKey": "bug-<slug>-comment" }`. The receipt's `createdId` is then the existing id, and note `"commentedOnExisting": true`.

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

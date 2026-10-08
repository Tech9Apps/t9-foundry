# Fetch Ticket

You are given a ticket/task/work-item ID: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, blank, or not provided, stop immediately and tell the user:**
> "A ticket ID is required. Usage: `/fetch-ticket <TICKET-ID>` (e.g. `/fetch-ticket ABCD-12345`)"
**Do not proceed with any further steps.**

## Prerequisites

Read `qa-config.json > ticketSource.type` to determine which source to fetch from. If `qa-config.json` is missing or `ticketSource.type` is unset, stop and tell the user to run `/init` or `/switch-project <profile>` first.

**Inline context override.** If the invoking agent supplied an already-resolved ticket source (see Step 0 of `.claude/agents/Manual-test-generator.md`), use those values in place of the config file and skip the missing-config stop above. When nothing is supplied inline — every slash-command invocation, and every other agent — `qa-config.json` is required exactly as stated.

> **Reference:** `.claude/guides/integration-sources.md` lists the fetch method per source — update it if a method changes here.

**Which path a source takes:** `github`, `clickup`, `azure`, `gitlab` and `bitbucket` go through the tracker adapter CLI (`scripts/tracker/cli.js`, see `docs/tracker-adapters.md`) — one tested interface instead of hand-written API calls. `jira` uses the Atlassian MCP server. `none` has no tracker.

## Fetch, by ticket source

### jira

Jira access is provided via the **Atlassian MCP server** (no credentials needed in `.env`).

- **Cloud ID**: use the inline-resolved `cloudId` if one was supplied, otherwise read `qa-config.json > ticketSource.jira.cloudId`. If neither is available, stop and tell the user to run `/init` or `/switch-project <profile>` first.

Use the `mcp__claude_ai_Atlassian__getJiraIssue` tool:
- `cloudId`: `<cloudId from qa-config.json>`
- `issueIdOrKey`: `$ARGUMENTS`
- `expand`: `renderedFields`
- `responseContentFormat`: `markdown`

Comments are included in the issue response when expanded. If not sufficient, use the issue key to fetch additional context via `mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql` with JQL: `key = $ARGUMENTS`.

Map into the output schema below:
- **Summary/Title** — `fields.summary`
- **Description** — from the response (markdown format)
- **Issue Type** — `fields.issuetype.name` (Bug, Story, etc.)
- **Status** — `fields.status.name`
- **Priority** — `fields.priority.name`
- **Labels** — `fields.labels`
- **Acceptance Criteria** — look in description or custom fields
- **Attachments** — `fields.attachment` array (filenames and URLs)
- **Comments** — from the response
- **Sub-tasks** — `fields.subtasks` (if any, fetch those too with `getJiraIssue`)

### github / clickup / azure / gitlab / bitbucket — via the tracker adapter CLI

```bash
node scripts/tracker/cli.js fetch --input '{"id":"$ARGUMENTS"}' --context-file tests/cases/.ticket-context/$ARGUMENTS.json
```

Pass the id exactly as given (a GitHub / GitLab / Bitbucket issue number, an Azure DevOps work item number, a ClickUp task id). The CLI reads the tracker settings from `qa-config.json > ticketSource`, reads the credential from the environment variable that config names (`GITHUB_TOKEN`, `CLICKUP_TOKEN`, `AZURE_DEVOPS_PAT`, `GITLAB_TOKEN`, `BITBUCKET_TOKEN`, or `ticketSource.<type>.tokenEnvVar`), and:

- prints `{ "ok": true, "data": <normalized ticket> }`, and
- writes the ticket-context file (schema below) itself — **you do not map fields by hand**.

Never put a token on the command line, in a file, or in your output.

If it prints `{ "ok": false, "error": … }`, branch on `error.code`:

| `error.code` | What to do |
|---|---|
| `NOT_FOUND` | The ticket does not exist (or this token cannot see it). Stop — this is the "ticket not found" case the orchestrating agents handle. |
| `UNAUTHENTICATED`, `FORBIDDEN`, `CONFIG` | Tell the user exactly what is wrong using `error.message` (e.g. "CLICKUP_TOKEN is not set") and how to fix it. Do not retry. |
| `VALIDATION` | The id is malformed for this tracker (e.g. a Jira-style key against GitHub). Say so and ask for the right id. |
| `RATE_LIMITED`, `TIMEOUT`, `NETWORK`, `UPSTREAM_ERROR` | The adapter already retried the read. Wait a few seconds and run it once more; if it fails again, report the code and message. |

Exit code `2` means the command itself was invoked wrongly (message on stderr) — fix the invocation, do not guess at the ticket.

### none

No ticket system is configured. Ask the engineer to describe the feature and acceptance criteria directly in the conversation. Use their answer as the requirements source for every downstream step — do not write a `tests/cases/.ticket-context/$ARGUMENTS.json` file, since there is no ticket to cache; instead carry the description forward in context for the Analyze Code / Create Test Cases steps.

## Output Schema (every source except `none`)

`tests/cases/.ticket-context/$ARGUMENTS.json` — written by the CLI for `github` / `clickup` / `azure` / `gitlab` / `bitbucket`; for `jira` you write it yourself from the mapping above:

```json
{
  "ticketId": "<TICKET-ID>",
  "source": "jira|azure|clickup|github|gitlab|bitbucket",
  "url": "...",
  "summary": "...",
  "issueType": "Story|Bug|Task|...",
  "status": "...",
  "priority": "...",
  "labels": [],
  "description": "... (markdown) ...",
  "acceptanceCriteria": "...",
  "attachments": [],
  "comments": [],
  "subtasks": []
}
```

## Output

Print a summary of the ticket:
- Title, type, status, priority
- Key acceptance criteria
- Number of attachments/comments
- Confirm the context file was saved at `tests/cases/.ticket-context/$ARGUMENTS.json` (or, for `none`, confirm the description was captured for this session)

# Fetch Ticket

You are given a ticket/task/work-item ID: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, blank, or not provided, stop immediately and tell the user:**
> "A ticket ID is required. Usage: `/fetch-ticket <TICKET-ID>` (e.g. `/fetch-ticket ABCD-12345`)"
**Do not proceed with any further steps.**

## Prerequisites

Read `qa-config.json > ticketSource.type` to determine which source to fetch from. If `qa-config.json` is missing or `ticketSource.type` is unset, stop and tell the user to run `/init` or `/switch-project <profile>` first.

> **Reference:** the method for each source below mirrors `.claude/guides/integration-sources.md` — update that file too if a fetch method changes here.

**Every `curl` call below uses `-f` (fail on HTTP error status, including 404) and `--max-time 30` (bound the wait).** A non-zero exit means the fetch failed — treat it as "ticket not found" for the purposes of the not-found handling in `Manual-test-generator.md`/`Manual-Automation-test-generator.md`, and don't proceed as if the response body were valid ticket data.

## Fetch, by ticket source

### jira

Jira access is provided via the **Atlassian MCP server** (no credentials needed in `.env`).

- **Cloud ID**: read from `qa-config.json > ticketSource.jira.cloudId`. If unset, stop and tell the user to run `/init` or `/switch-project <profile>` first.

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

### azure

Azure DevOps has no pre-configured MCP server in this workspace, so access goes through the Azure DevOps REST API directly, authenticated with a Personal Access Token (PAT) read from the environment — never hardcode credentials.

Read all values from `qa-config.json > ticketSource.azure`. If `qa-config.json` is missing or `organization`/`project` are unset, stop and tell the user to run `/init` or `/switch-project <profile>` first.

- **Organization**: `ticketSource.azure.organization`
- **Project**: `ticketSource.azure.project`
- **PAT env var**: named by `ticketSource.azure.tokenEnvVar` (default `AZURE_DEVOPS_PAT`) — read from the shell env, never written into any file or output
- **Base URL**: `{ticketSource.azure.host}/{organization}/{project}` (host defaults to `https://dev.azure.com`)

```bash
curl -fsS --max-time 30 -u ":$AZURE_DEVOPS_PAT" \
  "https://dev.azure.com/{organization}/{project}/_apis/wit/workitems/$ARGUMENTS?\$expand=all&api-version=7.1"
```

Comments are not included in the work item response above — fetch them separately:

```bash
curl -fsS --max-time 30 -u ":$AZURE_DEVOPS_PAT" \
  "https://dev.azure.com/{organization}/{project}/_apis/wit/workitems/$ARGUMENTS/comments?api-version=7.1-preview.3"
```

Map into the output schema below:
- **Title** — `fields["System.Title"]`
- **Description** — `fields["System.Description"]`
- **Issue Type** — `fields["System.WorkItemType"]` (Bug, User Story, Task, etc.)
- **Status** — `fields["System.State"]`
- **Priority** — `fields["Microsoft.VSTS.Common.Priority"]`
- **Labels** — `fields["System.Tags"]` (semicolon-separated string — split into an array)
- **Acceptance Criteria** — `fields["Microsoft.VSTS.Common.AcceptanceCriteria"]`
- **Attachments** — `relations[]` entries where `rel == "AttachedFile"` (filenames and URLs)
- **Comments** — from the comments response
- **Sub-tasks** — `relations[]` entries where `rel == "System.LinkTypes.Hierarchy-Forward"` (if any, fetch those too with the same work item endpoint)

### clickup

ClickUp access is provided via a Personal API Token, read from the environment — never hardcode it.

- **Token env var**: read `qa-config.json > ticketSource.clickup.tokenEnvVar` (defaults to `CLICKUP_TOKEN` if unset)
- If the env var is not set, stop and tell the user to run `/connect-tickets` or export the token per `docs/integration-guide.md`.

```bash
curl -fsS --max-time 30 -H "Authorization: $CLICKUP_TOKEN" \
  "https://api.clickup.com/api/v2/task/$ARGUMENTS?include_subtasks=true"
```

```bash
curl -fsS --max-time 30 -H "Authorization: $CLICKUP_TOKEN" \
  "https://api.clickup.com/api/v2/task/$ARGUMENTS/comment"
```

Map into the output schema below:
- **Title** — `name`
- **Description** — `text_content` (plain) or `description` (markdown, if present)
- **Issue Type** — ClickUp tasks have no native issue-type field; use a custom field named "Type"/"Task Type" if the list has one, otherwise default to `"Task"`
- **Status** — `status.status`
- **Priority** — `priority.priority` (`urgent`/`high`/`normal`/`low`)
- **Labels** — `tags[].name`
- **Acceptance Criteria** — look in `description`/`text_content` or a custom field
- **Attachments** — `attachments[]` (titles and URLs)
- **Comments** — from the comments response
- **Sub-tasks** — `subtasks[]` (present when `include_subtasks=true`; fetch each via the same task endpoint)

### github

Read the repo from `qa-config.json > ticketSource.github.repo` (owner/repo format) — this is the ticket-tracking repo, which may differ from `codeRepository.github.repo` (the app's source code repo).

```bash
gh issue view $ARGUMENTS --repo {ticketSource.github.repo} --json title,body,labels,milestone,comments
```

Map into the output schema below:
- **Title** — `title`
- **Description** — `body`
- **Issue Type** — infer from `labels` (e.g. a `bug` label → `"Bug"`), default `"Task"`
- **Status** — open/closed state from `gh issue view` output
- **Priority** — from a `priority:*` label if present, else `""`
- **Labels** — `labels[].name`
- **Acceptance Criteria** — look in `body`
- **Attachments** — not applicable, leave `[]`
- **Comments** — `comments`
- **Sub-tasks** — GitHub Issues has no native sub-task field, leave `[]`

### none

No ticket system is configured. Ask the engineer to describe the feature and acceptance criteria directly in the conversation. Use their answer as the requirements source for every downstream step — do not write a `tests/cases/.ticket-context/$ARGUMENTS.json` file, since there is no ticket to cache; instead carry the description forward in context for the Analyze Code / Create Test Cases steps.

## Output Schema (jira / azure / clickup / github)

Save to `tests/cases/.ticket-context/$ARGUMENTS.json`:

```json
{
  "ticketId": "<TICKET-ID>",
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

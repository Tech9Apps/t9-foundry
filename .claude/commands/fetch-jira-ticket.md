# Fetch Jira Ticket

You are given a Jira ticket ID: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, blank, or not provided, stop immediately and tell the user:**
> "A Jira ticket ID is required. Usage: `/fetch-ticket <TICKET-ID>` (e.g. `/fetch-ticket DGSSMART-12345`)"
**Do not proceed with any further steps.**

## Prerequisites

Jira access is provided via the **Atlassian MCP server** (no credentials needed in `.env`).

- **Cloud ID**: `technine.atlassian.net`

## Fetch Issue Details

Use the `mcp__claude_ai_Atlassian__getJiraIssue` tool:
- `cloudId`: `technine.atlassian.net`
- `issueIdOrKey`: `$ARGUMENTS`
- `expand`: `renderedFields`
- `responseContentFormat`: `markdown`

## Fetch Issue Comments

Comments are included in the issue response when expanded. If not sufficient, use the issue key to fetch additional context via `mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql` with JQL: `key = $ARGUMENTS`.

## Extract and Save

From the MCP response, extract the following and save to `tests/cases/.ticket-context/$ARGUMENTS.json`:

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

Save a JSON file with this structure:

```json
{
  "ticketId": "<TICKET-ID>",
  "summary": "...",
  "issueType": "Story|Bug|...",
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
- Confirm the context file was saved at `tests/cases/.ticket-context/$ARGUMENTS.json`

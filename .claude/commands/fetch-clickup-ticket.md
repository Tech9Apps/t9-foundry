# Fetch ClickUp Ticket

You are given a ClickUp task ID: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, blank, or not provided, stop immediately and tell the user:**
> "A ClickUp task ID is required. Usage: `/fetch-clickup-ticket <TASK-ID>` (e.g. `/fetch-clickup-ticket 86abc123`)"
**Do not proceed with any further steps.**

## Prerequisites

ClickUp access is provided via a Personal API Token, read from the environment — never hardcode it.

- **Token env var**: read `qa-config.json > ticketSource.clickup.tokenEnvVar` (defaults to `CLICKUP_TOKEN` if unset)
- If the env var is not set, stop and tell the user to run `/connect-tickets` or export the token per `docs/integration-guide.md`.

## Fetch Task Details

```bash
curl -s -H "Authorization: $CLICKUP_TOKEN" \
  "https://api.clickup.com/api/v2/task/$ARGUMENTS?include_subtasks=true"
```

## Fetch Task Comments

```bash
curl -s -H "Authorization: $CLICKUP_TOKEN" \
  "https://api.clickup.com/api/v2/task/$ARGUMENTS/comment"
```

## Extract and Save

From the API responses, extract the following and save to `tests/cases/.ticket-context/$ARGUMENTS.json`:

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

Save a JSON file with this structure:

```json
{
  "ticketId": "<TASK-ID>",
  "summary": "...",
  "issueType": "Task|Bug|...",
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

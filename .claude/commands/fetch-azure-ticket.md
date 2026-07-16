# Fetch Azure DevOps Ticket

You are given an Azure DevOps work item ID: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, blank, or not provided, stop immediately and tell the user:**
> "An Azure DevOps work item ID is required. Usage: `/fetch-azure-ticket <WORK-ITEM-ID>` (e.g. `/fetch-azure-ticket 12345`)"
**Do not proceed with any further steps.**

## Prerequisites

Azure DevOps has no pre-configured MCP server in this workspace, so access goes through the Azure DevOps REST API directly, authenticated with a Personal Access Token (PAT) read from the environment — never hardcode credentials.

Read all values from `qa-config.json > ticketSource.azure`. If `qa-config.json` is missing or `organization`/`project` are unset, stop and tell the user to run `/init` or `/switch-project <profile>` first.

- **Organization**: `ticketSource.azure.organization`
- **Project**: `ticketSource.azure.project`
- **PAT env var**: named by `ticketSource.azure.tokenEnvVar` (default `AZURE_DEVOPS_PAT`) — read from the shell env, never written into any file or output
- **Base URL**: `{ticketSource.azure.host}/{organization}/{project}` (host defaults to `https://dev.azure.com`)

## Fetch Work Item Details

```bash
curl -s -u ":$AZURE_DEVOPS_PAT" \
  "https://dev.azure.com/{organization}/{project}/_apis/wit/workitems/$ARGUMENTS?\$expand=all&api-version=7.1"
```

## Fetch Work Item Comments

Comments are not included in the work item response above — fetch them separately:

```bash
curl -s -u ":$AZURE_DEVOPS_PAT" \
  "https://dev.azure.com/{organization}/{project}/_apis/wit/workitems/$ARGUMENTS/comments?api-version=7.1-preview.3"
```

## Extract and Save

From the API responses, extract the following and save to `tests/cases/.ticket-context/$ARGUMENTS.json`:

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

Save a JSON file with this structure:

```json
{
  "ticketId": "<WORK-ITEM-ID>",
  "summary": "...",
  "issueType": "User Story|Bug|Task|...",
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

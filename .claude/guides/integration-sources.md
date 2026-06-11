# Integration Source Reference

## Fetching Tickets

| Source | Method |
|--------|--------|
| **Jira** | Atlassian MCP — `getJiraIssue`, `searchJiraIssuesUsingJql`. Pre-configured, no setup needed. |
| **ClickUp** | `curl -H "Authorization: $CLICKUP_TOKEN" https://api.clickup.com/api/v2/task/{id}` |
| **GitHub Issues** | `gh issue view {number} --repo owner/repo --json title,body,labels,milestone` |
| **GitLab Issues** | `curl -H "PRIVATE-TOKEN: $GITLAB_TOKEN" {host}/api/v4/projects/{id}/issues/{iid}` |
| **Bitbucket** | `curl` with `$BITBUCKET_TOKEN` against the Bitbucket REST API |
| **None** | Ask the engineer to describe the feature and acceptance criteria directly. Use their input as the requirements source for all downstream skills. |

## Uploading Test Cases

| Target | Method |
|--------|--------|
| **Jira** | `createJiraIssue` (MCP), then `createIssueLink` to parent ticket. Detect "Test" issue type via `getJiraProjectIssueTypesMetadata`; fall back to "Task". |
| **ClickUp** | `POST https://api.clickup.com/api/v2/list/{list_id}/task`, then POST checklist for steps |
| **GitHub Issues** | `gh issue create --label {testLabelName} --label {ticket-id}` |
| **None** | Save formatted markdown to `{testCasesDir}/` only. Report the file path. |

## Codebase Analysis

| Access method | When to use |
|--------------|-------------|
| Read + Bash tools directly | `codeRepository.localPath` is set and exists — fastest |
| `gh api repos/{owner}/{repo}/contents/{path}` | GitHub API only, no local clone |
| `curl -H "PRIVATE-TOKEN: $GITLAB_TOKEN"` | GitLab API only |
| Bitbucket REST API | Bitbucket, no local clone |

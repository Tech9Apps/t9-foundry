# Integration Source Reference

> **Maintenance note:** When adding a new ticket source or changing an API method, also update `docs/integration-guide.md` — it contains the corresponding end-user setup instructions for the same sources. If the source is one the commands+agents pipeline covers (Jira, Azure, ClickUp, GitHub, none): for an adapter-backed source, register the adapter (`scripts/tracker/adapters/index.js`) and add it to the "github / clickup / azure" sections of `.claude/commands/fetch-ticket.md`, `post-tests.md` and `file-bug.md` and to Step 6 of `.claude/agents/Manual-Automation-test-generator.md` (`tests/commands-adapter-drift.bats` fails if you forget); otherwise add a prose branch to each.

> **Adapter-backed sources.** GitHub, ClickUp and Azure DevOps are reached through `scripts/tracker/cli.js` (and `scripts/tracker/post-tests.js` for bulk test-case posting), documented in `docs/tracker-adapters.md`. The "Method" column below describes what that adapter does underneath; the commands call the CLI, not these endpoints directly. Jira stays on the Atlassian MCP; GitLab and Bitbucket still use direct `curl` calls in `file-bug.md` until their adapters exist.

## Fetching Tickets

| Source | Method |
|--------|--------|
| **Jira** | Atlassian MCP — `getJiraIssue`, `searchJiraIssuesUsingJql`. Pre-configured, no setup needed. Cloud ID from `ticketSource.jira.cloudId`. |
| **Azure DevOps** | `curl -u ":$AZURE_DEVOPS_PAT" {host}/{org}/{project}/_apis/wit/workitems/{id}?api-version=7.1` — org/project from `ticketSource.azure` |
| **ClickUp** | `curl -H "Authorization: $CLICKUP_TOKEN" https://api.clickup.com/api/v2/task/{id}` |
| **GitHub Issues** | REST `GET /repos/{owner}/{repo}/issues/{number}` (+ `/comments`) with `GITHUB_TOKEN` — via the adapter CLI, not `gh` |
| **GitLab Issues** | `curl -H "PRIVATE-TOKEN: $GITLAB_TOKEN" {host}/api/v4/projects/{id}/issues/{iid}` |
| **Bitbucket** | `curl` with `$BITBUCKET_TOKEN` against the Bitbucket REST API |
| **None** | Ask the engineer to describe the feature and acceptance criteria directly. Use their input as the requirements source for all downstream skills. |

## Uploading Test Cases

| Target | Method |
|--------|--------|
| **Jira** | `createJiraIssue` (MCP), then `createIssueLink` to parent ticket. Detect "Test" issue type via `getJiraProjectIssueTypesMetadata`; fall back to "Task". |
| **Azure DevOps** | `POST {host}/{org}/{project}/_apis/wit/workitems/$Test%20Case?api-version=7.1` (JSON-patch body), then PATCH a `Microsoft.VSTS.Common.TestedBy-Reverse` relation to the parent |
| **ClickUp** | `POST https://api.clickup.com/api/v2/list/{list_id}/task`, then POST checklist for steps |
| **GitHub Issues** | REST `POST /repos/{owner}/{repo}/issues` with labels `{testLabelName}` and the parent id — via `post-tests.js` |
| **None** | Save formatted markdown to `{testCasesDir}/` only. Report the file path. |

## Posting Automated Test Execution Results

| Target | Method |
|--------|--------|
| **Jira** | `addCommentToJiraIssue` (MCP) on the parent ticket |
| **Azure DevOps** | `PATCH {host}/{org}/{project}/_apis/wit/workitems/{id}?api-version=7.1` (JSON-patch, appends to `System.History`) |
| **ClickUp** | `POST https://api.clickup.com/api/v2/task/{id}/comment` |
| **GitHub Issues** | `gh issue comment {number} --repo owner/repo` |
| **None** | Save formatted markdown to `{testCasesDir}/{ticket-id}-execution-results.md` only. Report the file path. |

Used by `Manual-Automation-test-generator.md`'s Step 6, after running tests via `run-spec-tests.md`.

## Codebase Analysis

| Access method | When to use |
|--------------|-------------|
| Read + Bash tools directly | `codeRepository.localPath` is set and exists — fastest |
| `gh api repos/{owner}/{repo}/contents/{path}` | GitHub API only, no local clone |
| `curl -H "PRIVATE-TOKEN: $GITLAB_TOKEN"` | GitLab API only |
| Bitbucket REST API | Bitbucket, no local clone |

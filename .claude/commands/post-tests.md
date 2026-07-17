# Post Test Cases

You are given a ticket/task/work-item ID: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, stop immediately and tell the user:**
> "A ticket ID is required. Usage: `/post-tests <TICKET-ID>`"
**Do not proceed.**

## Prerequisites

Read `qa-config.json > ticketSource.type` to determine the upload target. If `qa-config.json` is missing or `ticketSource.type` is unset, stop and tell the user to run `/init` or `/switch-project <profile>` first.

- Manual test cases at `tests/cases/$ARGUMENTS.md`. If missing, tell the user to run `/create-manual-test-cases $ARGUMENTS` first.
- Automated test spec file (find the relevant `.spec.ts` that contains a `test.describe` block with `$ARGUMENTS` in its name, if any)

> **Reference:** the method for each target below mirrors `.claude/guides/integration-sources.md` — update that file too if an upload method changes here.

## Read Context

1. Read `tests/cases/$ARGUMENTS.md` to get all manual test cases
2. Read `tests/cases/.ticket-context/$ARGUMENTS.json` to get ticket context (skip if `ticketSource.type` is `none` — there is no context file)
3. Find and read the Playwright spec file that contains `$ARGUMENTS` in a `test.describe` block to get automated test cases (if any)

## Review Gate — Human Approval Required

Before posting anything to an external system, present the full list of test cases to the user for review. (Skip this gate only for `none` — nothing leaves the workspace in that case.)

### Present Test Cases for Review

Display a numbered table of all test cases that will be created:

```
## Test Cases for $ARGUMENTS — Review Before Posting

| # | TC ID | Summary | Priority | Type |
|---|-------|---------|----------|------|
| 1 | TC-001 | ... | High | Positive |
| 2 | TC-002 | ... | Medium | Edge Case |
...

Total: X test cases will be created in {ticket source}.
```

Then ask the user:

> **Please review the test cases above.** You can:
> - **Approve** — type `yes` or `approve` to proceed with posting
> - **Remove** — e.g. `remove TC-003, TC-007` to delete specific test cases
> - **Update** — e.g. `update TC-002 summary to "New title here"` to change a test case
> - **Add** — e.g. `add TC-017: Verify error toast when API fails` to add a new test case
>
> What would you like to do?

### Handle User Feedback

**Wait for the user's response.** Do NOT proceed to the external system until the user explicitly approves.

Process the user's feedback in a loop:

1. **Remove**: Delete the specified test cases from the list. Update the `tests/cases/$ARGUMENTS.md` file to remove them. Re-display the updated table.
2. **Update**: Modify the specified test case(s) in the list. Update the `tests/cases/$ARGUMENTS.md` file accordingly. Re-display the updated table.
3. **Add**: Add new test case(s) to the list with the next available TC-XXX number. Update the `tests/cases/$ARGUMENTS.md` file. Re-display the updated table.
4. **Approve**: Only when the user says `yes`, `approve`, `looks good`, `go ahead`, or similar confirmation — proceed to the next step.

After any remove/update/add action, re-display the updated table and ask for approval again. **Repeat until the user approves.**

## Post, by ticket source

### jira

Fetch the parent story/bug via `mcp__claude_ai_Atlassian__getJiraIssue`:
- `cloudId`: `<ticketSource.jira.cloudId from qa-config.json>`
- `issueIdOrKey`: `$ARGUMENTS`
- `fields`: `["components", "fixVersions"]`

Extract **Components** (`fields.components`, use `id`) and **Fix Versions** (`fields.fixVersions`, use `id`) — copied to each Test issue.

Identify the assignee: use `mcp__claude_ai_Atlassian__atlassianUserInfo` to get the current (connected) user's `accountId`.

For **each** manual test case, create a Jira **Test** issue via `mcp__claude_ai_Atlassian__createJiraIssue`:
- `cloudId`: `<ticketSource.jira.cloudId from qa-config.json>`
- `projectKey`: `<ticketSource.jira.projectKey from qa-config.json>`
- `issueTypeName`: `Test`
- `summary`: `TC-XXX: <test case title>`
- `assignee_account_id`: `<accountId from atlassianUserInfo>`
- `additional_fields`: `{"components": [{"id": "<component-id-from-parent>"}], "fixVersions": [{"id": "<version-id-from-parent>"}]}`

**Create issues in parallel batches** (up to 8 at a time). Collect all created issue keys.

For **each** created Test issue, link it to the parent via `mcp__claude_ai_Atlassian__createIssueLink`:
- `cloudId`: `<ticketSource.jira.cloudId from qa-config.json>`
- `inwardIssue`: `<created-test-issue-key>`
- `outwardIssue`: `$ARGUMENTS`
- `type`: `Test`

**Create links in parallel.** This populates the **Test Coverage** panel on the parent story/bug.

Save keys to `tests/cases/.ticket-context/$ARGUMENTS-test-keys.json`:
```json
{ "parentTicket": "$ARGUMENTS", "tests": [{ "tcId": "TC-001", "jiraKey": "<PROJECT-KEY>-XXXXX", "summary": "..." }] }
```

### azure

Read `ticketSource.azure` (organization, project, `tokenEnvVar` default `AZURE_DEVOPS_PAT`, `host` default `https://dev.azure.com`) — same fields as `fetch-ticket.md`'s azure branch.

Fetch parent work item fields:
```bash
curl -s -u ":$AZURE_DEVOPS_PAT" \
  "https://dev.azure.com/{organization}/{project}/_apis/wit/workitems/$ARGUMENTS?api-version=7.1"
```
Extract **Area Path** (`fields["System.AreaPath"]`) and **Iteration Path** (`fields["System.IterationPath"]`) — copied to each Test Case work item.

Identify the assignee via the PAT's associated user:
```bash
curl -s -u ":$AZURE_DEVOPS_PAT" \
  "https://vssps.dev.azure.com/{organization}/_apis/profile/profiles/me?api-version=7.1"
```
Extract `displayName`/`uniqueName` (email) to use as `System.AssignedTo`.

For **each** manual test case, create an Azure DevOps **Test Case** work item:
```bash
curl -s -X POST -u ":$AZURE_DEVOPS_PAT" \
  -H "Content-Type: application/json-patch+json" \
  -d '[
    {"op": "add", "path": "/fields/System.Title", "value": "TC-XXX: <test case title>"},
    {"op": "add", "path": "/fields/System.AreaPath", "value": "<area-path-from-parent>"},
    {"op": "add", "path": "/fields/System.IterationPath", "value": "<iteration-path-from-parent>"},
    {"op": "add", "path": "/fields/System.AssignedTo", "value": "<uniqueName-from-profile>"},
    {"op": "add", "path": "/fields/Microsoft.VSTS.Common.Priority", "value": <priority-number>},
    {"op": "add", "path": "/fields/Microsoft.VSTS.TCM.Steps", "value": "<steps-xml>"}
  ]' \
  "https://dev.azure.com/{organization}/{project}/_apis/wit/workitems/\$Test%20Case?api-version=7.1"
```

Priority mapping: High→1, Medium→2, Low→3, unspecified→4. Steps go in `Microsoft.VSTS.TCM.Steps` as ADO's steps XML:
```xml
<steps id="0" last="2">
  <step id="1" type="ActionStep">
    <parameterizedString isformatted="true">&lt;Step 1 action&gt;</parameterizedString>
    <parameterizedString isformatted="true">&lt;Step 1 expected result&gt;</parameterizedString>
  </step>
  <step id="2" type="ActionStep">
    <parameterizedString isformatted="true">&lt;Step 2 action&gt;</parameterizedString>
    <parameterizedString isformatted="true">&lt;Step 2 expected result&gt;</parameterizedString>
  </step>
</steps>
```

**Create work items in parallel batches** (up to 8 at a time). Collect all created work item IDs.

For **each** created Test Case work item, add a relation:
```bash
curl -s -X PATCH -u ":$AZURE_DEVOPS_PAT" \
  -H "Content-Type: application/json-patch+json" \
  -d '[{"op": "add", "path": "/relations/-", "value": {"rel": "Microsoft.VSTS.Common.TestedBy-Reverse", "url": "https://dev.azure.com/{organization}/{project}/_apis/wit/workitems/$ARGUMENTS"}}]' \
  "https://dev.azure.com/{organization}/{project}/_apis/wit/workitems/<created-work-item-id>?api-version=7.1"
```
**Create links in parallel.** This populates **Tested By / Tests** on the parent.

Save keys to `tests/cases/.ticket-context/$ARGUMENTS-test-keys.json`:
```json
{ "parentWorkItem": "$ARGUMENTS", "tests": [{ "tcId": "TC-001", "workItemId": "XXXXX", "summary": "..." }] }
```

### clickup

Read `ticketSource.clickup.tokenEnvVar` (default `CLICKUP_TOKEN`) and `ticketSource.clickup.listId`.

Identify the assignee: `curl -s -H "Authorization: $CLICKUP_TOKEN" "https://api.clickup.com/api/v2/user"`, extract `user.id`.

For **each** manual test case:

a. Create the task:
```bash
curl -s -X POST -H "Authorization: $CLICKUP_TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "TC-XXX: <test case title>", "description": "<preconditions + description>", "priority": <priority_num>, "assignees": [<user_id>]}' \
  "https://api.clickup.com/api/v2/list/{listId}/task"
```
Priority mapping: High→1, Medium→2, Low→3, unspecified→4

b. Add test steps as a checklist:
```bash
curl -s -X POST -H "Authorization: $CLICKUP_TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Test Steps"}' \
  "https://api.clickup.com/api/v2/task/{task_id}/checklist"
```
Then add each step as a checklist item:
```bash
curl -s -X POST -H "Authorization: $CLICKUP_TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "<step text> — Expected: <expected result>"}' \
  "https://api.clickup.com/api/v2/checklist/{checklist_id}/checklist_item"
```

**Create tasks in parallel batches** (up to 8 at a time). Collect all created task IDs.

For **each** created test task, link it to the parent task:
```bash
curl -s -X POST -H "Authorization: $CLICKUP_TOKEN" \
  "https://api.clickup.com/api/v2/task/{created_task_id}/link/$ARGUMENTS"
```
**Create links in parallel.** This adds the parent task under **Linked Tasks**.

Save keys to `tests/cases/.ticket-context/$ARGUMENTS-test-keys.json`:
```json
{ "parentTask": "$ARGUMENTS", "tests": [{ "tcId": "TC-001", "clickupTaskId": "XXXXX", "summary": "..." }] }
```

### github

Read `ticketSource.github.repo` (owner/repo) and `ticketSource.github.testLabelName` (default `test-case`).

For **each** manual test case:
```bash
gh issue create --repo {ticketSource.github.repo} \
  --title "TC-XXX: <test case title>" \
  --body "<formatted body: preconditions, steps, expected result>" \
  --label "{testLabelName}" \
  --label "$ARGUMENTS"
```
GitHub Issues has no native issue-linking API via `gh issue create` — reference the parent in the body text (e.g. "Tests #$ARGUMENTS") instead of a structured link field.

Save keys to `tests/cases/.ticket-context/$ARGUMENTS-test-keys.json`:
```json
{ "parentIssue": "$ARGUMENTS", "tests": [{ "tcId": "TC-001", "githubIssueNumber": "XXXXX", "summary": "..." }] }
```

### none

No ticket system is configured — no remote upload is possible or attempted. The test cases are already saved as `tests/cases/$ARGUMENTS.md`; that is the sharable artifact. Report the file path and suggest sharing it with the team or importing it into a test management tool manually. Skip the "Save Created Test Keys" step — there is nothing remote to record.

## Output

- Confirm all test cases created successfully (or, for `none`, confirm the file path)
- Print a table: TC ID | Remote ID | Summary
- Confirm links to the parent ticket/work item/task were created (not applicable for `github` or `none`)
- Print total count created

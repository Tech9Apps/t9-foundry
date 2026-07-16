# Post Test Cases to Jira

You are given a Jira ticket ID: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, stop immediately and tell the user:**
> "A Jira ticket ID is required. Usage: `/post-tests-to-jira <TICKET-ID>`"
**Do not proceed.**

## Prerequisites

- Read `qa-config.json` first — it provides the Jira Cloud ID (`ticketSource.jira.cloudId`) and project key (`ticketSource.jira.projectKey`). If `qa-config.json` is missing or these fields are unset, stop and tell the user to run `/init` or `/switch-project <profile>` first.
- Jira access via the **Atlassian MCP server** (Cloud ID from config)
- Manual test cases at `tests/cases/$ARGUMENTS.md`
- Automated test spec file (find the relevant `.spec.ts` that contains a `test.describe` block with `$ARGUMENTS` in its name)

If the test cases file doesn't exist, tell the user to run `/create-test-cases $ARGUMENTS` first.

## Read Context

1. Read `tests/cases/$ARGUMENTS.md` to get all manual test cases
2. Read `tests/cases/.ticket-context/$ARGUMENTS.json` to get ticket context
3. Find and read the Playwright spec file that contains `$ARGUMENTS` in a `test.describe` block to get automated test cases (if any)

## Review Gate — Human Approval Required

Before posting anything to Jira, present the full list of test cases to the user for review.

### Present Test Cases for Review

Display a numbered table of all test cases that will be created in Jira:

```
## Test Cases for $ARGUMENTS — Review Before Posting

| # | TC ID | Summary | Priority | Type |
|---|-------|---------|----------|------|
| 1 | TC-001 | ... | High | Positive |
| 2 | TC-002 | ... | Medium | Edge Case |
...

Total: X test cases will be created as Xray Test issues in Jira.
```

Then ask the user:

> **Please review the test cases above.** You can:
> - **Approve** — type `yes` or `approve` to proceed with posting to Jira
> - **Remove** — e.g. `remove TC-003, TC-007` to delete specific test cases
> - **Update** — e.g. `update TC-002 summary to "New title here"` to change a test case
> - **Add** — e.g. `add TC-017: Verify error toast when API fails` to add a new test case
>
> What would you like to do?

### Handle User Feedback

**Wait for the user's response.** Do NOT proceed to Jira until the user explicitly approves.

Process the user's feedback in a loop:

1. **Remove**: Delete the specified test cases from the list. Update the `tests/cases/$ARGUMENTS.md` file to remove them. Re-display the updated table.
2. **Update**: Modify the specified test case(s) in the list. Update the `tests/cases/$ARGUMENTS.md` file accordingly. Re-display the updated table.
3. **Add**: Add new test case(s) to the list with the next available TC-XXX number. Update the `tests/cases/$ARGUMENTS.md` file. Re-display the updated table.
4. **Approve**: Only when the user says `yes`, `approve`, `looks good`, `go ahead`, or similar confirmation — proceed to the next step.

After any remove/update/add action, re-display the updated table and ask for approval again. **Repeat until the user approves.**

## Fetch Parent Story Fields

Use `mcp__claude_ai_Atlassian__getJiraIssue` to fetch the parent story/bug:
- `cloudId`: `<ticketSource.jira.cloudId from qa-config.json>`
- `issueIdOrKey`: `$ARGUMENTS`
- `fields`: `["components", "fixVersions"]`

Extract from the response:
- **Components** — `fields.components` array (use the `id` field from each component)
- **Fix Versions** — `fields.fixVersions` array (use the `id` field from each version)

These will be copied to each Test issue.

## Identify the Assignee

The assignee for all Test issues is the **connected Jira user** (the person whose MCP connection is active). To get this account ID:
- Use `mcp__claude_ai_Atlassian__atlassianUserInfo` to get the current user's `accountId`

## Create Xray Test Issues

For **each** manual test case (TC-001, TC-002, etc.), create a Jira **Test** issue using `mcp__claude_ai_Atlassian__createJiraIssue`:

- `cloudId`: `<ticketSource.jira.cloudId from qa-config.json>`
- `projectKey`: `<ticketSource.jira.projectKey from qa-config.json>`
- `issueTypeName`: `Test`
- `summary`: `TC-XXX: <test case title>` (from the manual test cases file)
- `assignee_account_id`: `<accountId from atlassianUserInfo>`
- `additional_fields`:
  ```json
  {
    "components": [{"id": "<component-id-from-parent>"}],
    "fixVersions": [{"id": "<version-id-from-parent>"}]
  }
  ```

**Create issues in parallel batches** (up to 8 at a time) for speed.

Collect all created issue keys (e.g., `<PROJECT-KEY>-12867`, `<PROJECT-KEY>-12868`, ...).

## Link Test Issues to Parent Story

For **each** created Test issue, create an issue link using `mcp__claude_ai_Atlassian__createIssueLink`:

- `cloudId`: `<ticketSource.jira.cloudId from qa-config.json>`
- `inwardIssue`: `<created-test-issue-key>` (the Test issue — it "tests" the story)
- `outwardIssue`: `$ARGUMENTS` (the parent story/bug — it "is tested by" the Test)
- `type`: `Test`

**Create links in parallel** for speed.

This populates the **Test Coverage** panel on the parent story/bug in Jira.

## Save Created Test Keys

Save the mapping of test case IDs to Jira keys to `tests/cases/.ticket-context/$ARGUMENTS-test-keys.json`:

```json
{
  "parentTicket": "$ARGUMENTS",
  "tests": [
    { "tcId": "TC-001", "jiraKey": "<PROJECT-KEY>-XXXXX", "summary": "..." },
    { "tcId": "TC-002", "jiraKey": "<PROJECT-KEY>-XXXXX", "summary": "..." }
  ]
}
```

## Output

- Confirm all Test issues created successfully
- Print a table: TC ID | Jira Key | Summary
- Confirm all issues linked to parent story under Test Coverage
- Print total count of Test issues created

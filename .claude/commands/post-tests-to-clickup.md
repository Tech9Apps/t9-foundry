# Post Test Cases to ClickUp

You are given a ClickUp task ID: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, stop immediately and tell the user:**
> "A ClickUp task ID is required. Usage: `/post-tests-to-clickup <TASK-ID>`"
**Do not proceed.**

## Prerequisites

- ClickUp access via a Personal API Token, read from the environment — never hardcode it:
  - Token env var: `qa-config.json > ticketSource.clickup.tokenEnvVar` (defaults to `CLICKUP_TOKEN` if unset)
  - List to create test tasks in: `qa-config.json > ticketSource.clickup.listId`
- Manual test cases at `tests/cases/$ARGUMENTS.md`
- Automated test spec file (find the relevant `.spec.ts` that contains a `test.describe` block with `$ARGUMENTS` in its name, if any)

If the test cases file doesn't exist, tell the user to run `/create-manual-test-cases $ARGUMENTS` first.

## Read Context

1. Read `tests/cases/$ARGUMENTS.md` to get all manual test cases
2. Read `tests/cases/.ticket-context/$ARGUMENTS.json` to get task context
3. Find and read the Playwright spec file that contains `$ARGUMENTS` in a `test.describe` block to get automated test cases (if any)

## Review Gate — Human Approval Required

Before posting anything to ClickUp, present the full list of test cases to the user for review.

### Present Test Cases for Review

Display a numbered table of all test cases that will be created in ClickUp:

```
## Test Cases for $ARGUMENTS — Review Before Posting

| # | TC ID | Summary | Priority | Type |
|---|-------|---------|----------|------|
| 1 | TC-001 | ... | High | Positive |
| 2 | TC-002 | ... | Medium | Edge Case |
...

Total: X test cases will be created as tasks in ClickUp list {listId}.
```

Then ask the user:

> **Please review the test cases above.** You can:
> - **Approve** — type `yes` or `approve` to proceed with posting to ClickUp
> - **Remove** — e.g. `remove TC-003, TC-007` to delete specific test cases
> - **Update** — e.g. `update TC-002 summary to "New title here"` to change a test case
> - **Add** — e.g. `add TC-017: Verify error toast when API fails` to add a new test case
>
> What would you like to do?

### Handle User Feedback

**Wait for the user's response.** Do NOT proceed to ClickUp until the user explicitly approves.

Process the user's feedback in a loop:

1. **Remove**: Delete the specified test cases from the list. Update the `tests/cases/$ARGUMENTS.md` file to remove them. Re-display the updated table.
2. **Update**: Modify the specified test case(s) in the list. Update the `tests/cases/$ARGUMENTS.md` file accordingly. Re-display the updated table.
3. **Add**: Add new test case(s) to the list with the next available TC-XXX number. Update the `tests/cases/$ARGUMENTS.md` file. Re-display the updated table.
4. **Approve**: Only when the user says `yes`, `approve`, `looks good`, `go ahead`, or similar confirmation — proceed to the next step.

After any remove/update/add action, re-display the updated table and ask for approval again. **Repeat until the user approves.**

## Identify the Assignee

The assignee for all test tasks is the **token's associated user**. To get this:

```bash
curl -s -H "Authorization: $CLICKUP_TOKEN" "https://api.clickup.com/api/v2/user"
```

Extract `user.id` to use as the assignee on created tasks.

## Create Test Case Tasks

For **each** manual test case (TC-001, TC-002, etc.):

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

**Create tasks in parallel batches** (up to 8 at a time) for speed.

Collect all created task IDs.

## Link Test Case Tasks to Parent Task

For **each** created test task, link it to the parent task:

```bash
curl -s -X POST -H "Authorization: $CLICKUP_TOKEN" \
  "https://api.clickup.com/api/v2/task/{created_task_id}/link/$ARGUMENTS"
```

**Create links in parallel** for speed.

This adds the parent task under **Linked Tasks** for each created test task.

## Save Created Test Keys

Save the mapping of test case IDs to ClickUp task IDs to `tests/cases/.ticket-context/$ARGUMENTS-test-keys.json`:

```json
{
  "parentTask": "$ARGUMENTS",
  "tests": [
    { "tcId": "TC-001", "clickupTaskId": "XXXXX", "summary": "..." },
    { "tcId": "TC-002", "clickupTaskId": "XXXXX", "summary": "..." }
  ]
}
```

## Output

- Confirm all test tasks created successfully
- Print a table: TC ID | ClickUp Task ID | Summary
- Confirm all tasks linked to the parent task
- Print total count of test tasks created

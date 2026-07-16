# Post Test Cases to Azure DevOps

You are given an Azure DevOps work item ID: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, stop immediately and tell the user:**
> "An Azure DevOps work item ID is required. Usage: `/post-tests-to-azure <WORK-ITEM-ID>`"
**Do not proceed.**

## Prerequisites

- Azure DevOps access via a Personal Access Token, read from the environment — never hardcode it. Read all values from `qa-config.json > ticketSource.azure` (same as `fetch-azure-ticket.md`); if missing/unset, stop and tell the user to run `/init` or `/switch-project <profile>` first:
  - Organization: `ticketSource.azure.organization`
  - Project: `ticketSource.azure.project`
  - PAT env var: named by `ticketSource.azure.tokenEnvVar` (default `AZURE_DEVOPS_PAT`)
  - Host: `ticketSource.azure.host` (default `https://dev.azure.com`)
- Manual test cases at `tests/cases/$ARGUMENTS.md`
- Automated test spec file (find the relevant `.spec.ts` that contains a `test.describe` block with `$ARGUMENTS` in its name, if any)

If the test cases file doesn't exist, tell the user to run `/create-manual-test-cases $ARGUMENTS` first.

## Read Context

1. Read `tests/cases/$ARGUMENTS.md` to get all manual test cases
2. Read `tests/cases/.ticket-context/$ARGUMENTS.json` to get work item context
3. Find and read the Playwright spec file that contains `$ARGUMENTS` in a `test.describe` block to get automated test cases (if any)

## Review Gate — Human Approval Required

Before posting anything to Azure DevOps, present the full list of test cases to the user for review.

### Present Test Cases for Review

Display a numbered table of all test cases that will be created in Azure DevOps:

```
## Test Cases for $ARGUMENTS — Review Before Posting

| # | TC ID | Summary | Priority | Type |
|---|-------|---------|----------|------|
| 1 | TC-001 | ... | High | Positive |
| 2 | TC-002 | ... | Medium | Edge Case |
...

Total: X test cases will be created as Test Case work items in Azure DevOps.
```

Then ask the user:

> **Please review the test cases above.** You can:
> - **Approve** — type `yes` or `approve` to proceed with posting to Azure DevOps
> - **Remove** — e.g. `remove TC-003, TC-007` to delete specific test cases
> - **Update** — e.g. `update TC-002 summary to "New title here"` to change a test case
> - **Add** — e.g. `add TC-017: Verify error toast when API fails` to add a new test case
>
> What would you like to do?

### Handle User Feedback

**Wait for the user's response.** Do NOT proceed to Azure DevOps until the user explicitly approves.

Process the user's feedback in a loop:

1. **Remove**: Delete the specified test cases from the list. Update the `tests/cases/$ARGUMENTS.md` file to remove them. Re-display the updated table.
2. **Update**: Modify the specified test case(s) in the list. Update the `tests/cases/$ARGUMENTS.md` file accordingly. Re-display the updated table.
3. **Add**: Add new test case(s) to the list with the next available TC-XXX number. Update the `tests/cases/$ARGUMENTS.md` file. Re-display the updated table.
4. **Approve**: Only when the user says `yes`, `approve`, `looks good`, `go ahead`, or similar confirmation — proceed to the next step.

After any remove/update/add action, re-display the updated table and ask for approval again. **Repeat until the user approves.**

## Fetch Parent Work Item Fields

```bash
curl -s -u ":$AZURE_DEVOPS_PAT" \
  "https://dev.azure.com/{organization}/{project}/_apis/wit/workitems/$ARGUMENTS?api-version=7.1"
```

Extract from the response:
- **Area Path** — `fields["System.AreaPath"]`
- **Iteration Path** — `fields["System.IterationPath"]`

These will be copied to each Test Case work item so it groups with its parent.

## Identify the Assignee

The assignee for all Test Case work items is the **PAT's associated user**. To get this:

```bash
curl -s -u ":$AZURE_DEVOPS_PAT" \
  "https://vssps.dev.azure.com/{organization}/_apis/profile/profiles/me?api-version=7.1"
```

Extract `displayName`/`uniqueName` (email) to use as `System.AssignedTo`.

## Create Test Case Work Items

For **each** manual test case (TC-001, TC-002, etc.), create an Azure DevOps **Test Case** work item:

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

Priority mapping: High→1, Medium→2, Low→3, unspecified→4

Steps go in the `Microsoft.VSTS.TCM.Steps` field as ADO's steps XML format:

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

**Create work items in parallel batches** (up to 8 at a time) for speed.

Collect all created work item IDs.

## Link Test Case Work Items to Parent

For **each** created Test Case work item, add a relation:

```bash
curl -s -X PATCH -u ":$AZURE_DEVOPS_PAT" \
  -H "Content-Type: application/json-patch+json" \
  -d '[{"op": "add", "path": "/relations/-", "value": {"rel": "Microsoft.VSTS.Common.TestedBy-Reverse", "url": "https://dev.azure.com/{organization}/{project}/_apis/wit/workitems/$ARGUMENTS"}}]' \
  "https://dev.azure.com/{organization}/{project}/_apis/wit/workitems/<created-work-item-id>?api-version=7.1"
```

**Create links in parallel** for speed.

This populates the **Tested By / Tests** links on the parent work item.

## Save Created Test Keys

Save the mapping of test case IDs to Azure DevOps work item IDs to `tests/cases/.ticket-context/$ARGUMENTS-test-keys.json`:

```json
{
  "parentWorkItem": "$ARGUMENTS",
  "tests": [
    { "tcId": "TC-001", "workItemId": "XXXXX", "summary": "..." },
    { "tcId": "TC-002", "workItemId": "XXXXX", "summary": "..." }
  ]
}
```

## Output

- Confirm all Test Case work items created successfully
- Print a table: TC ID | Work Item ID | Summary
- Confirm all work items linked to the parent under Tested By / Tests
- Print total count of Test Case work items created

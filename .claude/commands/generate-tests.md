# Generate Tests — Orchestrator

You are given a Jira ticket ID: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, blank, or not provided, stop immediately and tell the user:**
> "A Jira ticket ID is required. Usage: `/generate-tests <TICKET-ID>` (e.g. `/generate-tests ABCD-12345`)"
**Do not proceed with any further steps.**

This is an orchestrator command that runs the full test generation pipeline using agents. Execute each step below in order. Use the **Agent tool** to run steps in parallel where possible.

## Prerequisites

- Jira access via the **Atlassian MCP server** (Cloud ID: `technine.atlassian.net`)

## Step 1: Fetch Ticket + Analyze Code (parallel)

Launch **two agents in parallel**:

**Agent 1 — Fetch Ticket:**
- Fetch the Jira ticket `$ARGUMENTS` using the Atlassian MCP tools:
  - Use `mcp__claude_ai_Atlassian__getJiraIssue` with `cloudId: "technine.atlassian.net"`, `issueIdOrKey: "$ARGUMENTS"`, `expand: "renderedFields"`, `responseContentFormat: "markdown"`
- Extract: summary, description (markdown), issue type, status, priority, labels, acceptance criteria, attachments, comments, subtasks
- Save extracted context to `tests/cases/.ticket-context/$ARGUMENTS.json`

**Agent 2 — Analyze Code:**
- Wait for Agent 1 to complete (needs ticket context), OR if you can determine the feature area from the ticket ID alone, start exploring the <Project> source code at `/Users/<user_name>/workspace/<Project>`
- Search: frontend routes (`ui/src/routes/_protected/`), components (`ui/src/components/`), services (`ui/src/common/store/services/`), backend handlers (`services/functions/modules/`), constants (`ui/src/common/constants/`)
- Identify: UI elements, selectors, validations, API endpoints, RBAC rules
- Save analysis to `tests/cases/.ticket-context/$ARGUMENTS-analysis.md`

**If parallel is not possible**, run them sequentially: fetch ticket first, then analyze code.

## Step 2: Create Test Cases

Using the ticket context and code analysis, generate:

**Manual test cases** → `tests/cases/$ARGUMENTS.md`
- Cover all acceptance criteria, positive/negative/edge cases
- Reference actual selectors from source code

**Automated Playwright tests** → `tests/<module>/<FeatureName>.spec.ts`
- **Bug tickets**: max 2 consolidated tests
- **Story tickets**: max 4 consolidated tests
- Name spec file after the feature, NOT the ticket ID
- Put ticket ID in `test.describe` and `test()` names
- If spec file for this feature exists, append a new `test.describe` block
- Create page objects (`pages/`) and agents (`agents/`) as needed

## Step 3: Post Test Cases to Jira

**Before executing tests**, post both manual and automated test cases to Jira:

Use the `mcp__claude_ai_Atlassian__addCommentToJiraIssue` tool:
- `cloudId`: `technine.atlassian.net`
- `issueIdOrKey`: `$ARGUMENTS`
- `contentFormat`: `markdown`
- `commentBody`: markdown content with two sections:
  1. **## Manual Test Cases** — table with ID | Title | Priority | Type + total count
  2. **## Automated Test Cases** — table with ID | Title | Priority | Type + total count + file paths

Save the **comment ID** from the response for later reference.

## Step 4: Execute Playwright Tests

Run tests in **headed mode**:

```bash
npx playwright test <spec-file> --headed --reporter=list
```

Handle failures with **max 3 retry cycles**:
1. Selector issues → fix page object, re-run
2. Timing issues → add waits, re-run
3. Logic errors → fix spec, re-run

Capture: total run, passed, failed, skipped, execution time, failure details.

## Step 5: Post Execution Results to Jira

Post a **new follow-up comment** with execution results:

Use the `mcp__claude_ai_Atlassian__addCommentToJiraIssue` tool:
- `cloudId`: `technine.atlassian.net`
- `issueIdOrKey`: `$ARGUMENTS`
- `contentFormat`: `markdown`
- `commentBody`: markdown content with:
  - **## Test Execution Results**
  - Total tests run, passed, failed, skipped
  - Execution time
  - Failure details (if any)

## Final Output

Provide a summary:
1. Jira ticket details (title, type, key points)
2. Source files analyzed
3. Number of test cases generated (manual + automated)
4. File paths created
5. Test execution results (passed/failed/skipped)
6. Jira comment posted (confirm success)
7. Any questions or ambiguities found

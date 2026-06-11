# upload-tests

Upload written test cases to the configured ticket management system (Jira, ClickUp, or GitHub Issues). When no ticket system is configured, saves test cases as formatted markdown files only.

> **Reference:** API methods and upload targets are in `.claude/guides/integration-sources.md`. Update that file when adding a new upload target.

## When to invoke

Trigger phrases: "upload test cases", "push test cases to Jira", "upload to ClickUp", "sync test cases", "create test cases in Jira", "publish test cases", "send test cases to the tracker"

## Arguments

Required: `TICKET-ID` or feature name — the identifier used when the test cases were written.

Example: `/upload-tests JIRA-123` or `/upload-tests user-checkout`

## Steps

1. **Load test cases**
   Read `{testCasesDir}/{ticket-id}-test-cases.json`. If it doesn't exist, run `/write-test-cases {ticket-id}` first.

1a. **Check ticket source**
   Read `ticketSource.type` from `qa-config.json`. If it is `"none"`, skip to **No ticket system** below.

2. **Confirm before uploading**
   Display a summary: "{count} test cases will be uploaded to {ticketSource.type}. Proceed?"

3. **Upload based on ticket source**

   ### Jira
   For each test case in the JSON:

   a. Create the test case issue:
   ```
   mcp__claude_ai_Atlassian__createJiraIssue with:
     - project: qa-config.ticketSource.jira.projectKey
     - issuetype: qa-config.ticketSource.jira.testIssueType (e.g., "Test" or "Task")
     - summary: test case title
     - description: formatted steps and expected results
     - priority: mapped from test case priority (High→High, Medium→Medium, Low→Low)
     - labels: ["qa-harness", ticket-id]
   ```

   b. Link to parent ticket:
   ```
   mcp__claude_ai_Atlassian__createIssueLink with:
     - type: qa-config.ticketSource.jira.linkType
     - inwardIssue: new test case issue key
     - outwardIssue: TICKET-ID
   ```

   c. If issue type "Test" is unavailable and "Task" was used, add a comment to the created task with formatted test steps.

   ### ClickUp
   For each test case:

   a. Create the task:
   ```
   curl -s -X POST -H "Authorization: $CLICKUP_TOKEN" -H "Content-Type: application/json" \
     -d '{"name": "{title}", "description": "{preconditions}", "priority": {priority_num}}' \
     "https://api.clickup.com/api/v2/list/{listId}/task"
   ```
   Priority mapping: High→1, Medium→2, Low→3

   b. Add test steps as a checklist:
   ```
   curl -s -X POST -H "Authorization: $CLICKUP_TOKEN" -H "Content-Type: application/json" \
     -d '{"name": "Test Steps"}' \
     "https://api.clickup.com/api/v2/task/{task_id}/checklist"
   ```
   Add each step as a checklist item.

   c. Add a comment linking back to the parent ticket ID.

   ### GitHub Issues
   For each test case:
   ```
   gh issue create \
     --repo {owner/repo} \
     --title "Test: {title}" \
     --body "{formatted body with steps}" \
     --label "{testLabelName}" \
     --label "{ticket-id}"
   ```

   ### No ticket system (`ticketSource.type = "none"`)
   No remote upload is possible. Instead:
   - The test cases are already saved as `{testCasesDir}/{id}-test-cases.md` — this is the sharable artifact.
   - Format the markdown file cleanly using the Jira-style format from `templates/test-case-formats.md` for readability.
   - Report the file path and suggest: "Share `{testCasesDir}/{id}-test-cases.md` with your team, or import it into your test management tool manually."
   - Skip steps 4 and 5.

4. **Handle failures**
   If any individual upload fails, note it but continue with remaining test cases. Report failures at the end.

5. **Save upload receipt**
   Write `{testCasesDir}/{ticket-id}-upload-receipt.json`:
   ```json
   {
     "uploadedAt": "{ISO timestamp}",
     "ticketSource": "...",
     "parentTicketId": "TICKET-ID",
     "results": [
       { "testCaseId": "TC-001", "status": "created", "remoteId": "JIRA-456", "url": "..." },
       { "testCaseId": "TC-002", "status": "failed", "error": "..." }
     ]
   }
   ```

6. **Report**
   Show: {count} created successfully, {count} failed. List links to created items.

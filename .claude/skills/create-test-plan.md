# create-test-plan

Generate a structured test plan by combining ticket requirements with codebase analysis.

## When to invoke

Trigger phrases: "create a test plan", "generate test plan", "make a test plan for", "plan tests for this ticket", "test plan for TICKET-", "what should I test for this feature", "test coverage plan"

## Arguments

- With ticket source configured: `TICKET-ID` (e.g., `/create-test-plan JIRA-123`)
- Without ticket source (`ticketSource.type = "none"`): a short feature name used as the plan filename (e.g., `/create-test-plan user-checkout`)

## Steps

1. **Read qa-config.json**
   Get `ticketSource`, `environments`, `productionProtection`, and `testOutput.testPlansDir`. Stop if config is missing.

2. **Fetch the ticket or collect requirements**

   **Jira:**
   ```
   mcp__claude_ai_Atlassian__getJiraIssue with issueIdOrKey = TICKET-ID
   ```
   Extract: summary, description, acceptance criteria, story type, priority, linked issues, labels.

   **ClickUp:**
   ```
   curl -s -H "Authorization: $CLICKUP_TOKEN" "https://api.clickup.com/api/v2/task/{task_id}"
   ```

   **GitHub Issues:**
   ```
   gh issue view {number} --repo {owner/repo} --json title,body,labels,milestone,comments
   ```

   **GitLab:**
   ```
   curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "{host}/api/v4/projects/{id}/issues/{iid}"
   ```

   **No ticket system (`ticketSource.type = "none"`):**
   Ask the engineer to describe the feature. Prompt with:
   - "What is the feature or user story being tested? (describe what it does)"
   - "What are the acceptance criteria or expected behaviors?"
   - "Are there any known edge cases or risk areas?"
   Use the argument as the plan's identifier/filename (e.g., `user-checkout`).

3. **Check for existing codebase analysis**
   Look for `{analysisDir}/{ticket-id}-analysis.md` or `{analysisDir}/latest-analysis.md`.
   - If found and created within the last 7 days: use it
   - If missing or older than 7 days: run `/analyze-codebase {ticket-id}` before proceeding

4. **Generate the test plan**
   Use the template from `templates/test-plan-template.md` as the structure. Fill it in using the ticket content and codebase analysis.

   The plan must include:
   - **Objective** — what this test plan validates
   - **Scope** — features, user flows, and code paths covered
   - **Out of Scope** — explicitly what is NOT tested (and why)
   - **Test Types** — functional, negative/error, boundary, regression, performance (if relevant)
   - **Risk Areas** — from the codebase analysis
   - **Test Cases Summary** — list of test scenario titles (not full steps; those come in `/write-test-cases`)
   - **Dependencies** — other tickets, external services, data setup needs
   - **Data Requirements** — what test data must be created
   - **Environment Requirements** — explicitly state the approved test environment URL from `qa-config.json`
   - **Excluded Environments** — explicitly state "Production environment is excluded. Tests must only run against {testEnvironmentBaseUrl}."
   - **Estimated Test Count** — rough number of test cases expected

5. **Save the plan**
   Save to `{testPlansDir}/{ticket-id}-test-plan.md`. Create the directory if needed.

6. **Review prompt**
   Display the test plan and ask: "Does this test plan look correct? Reply 'yes' to proceed to writing test cases with `/write-test-cases {ticket-id}`, or tell me what to adjust."

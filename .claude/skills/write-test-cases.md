# write-test-cases

Expand a test plan into individual, detailed test cases in the format appropriate for the upload target.

## When to invoke

Trigger phrases: "write test cases", "create test cases", "generate test cases for", "write BDD scenarios", "turn this test plan into test cases", "expand the test plan", "write detailed test cases"

## Arguments

Required: `TICKET-ID`

Example: `/write-test-cases JIRA-123`

## Steps

1. **Load the test plan**
   Read `{testPlansDir}/{ticket-id}-test-plan.md`. If it doesn't exist, run `/create-test-plan {ticket-id}` first.

2. **Determine format**
   Ask: "What format should I use for test cases?"
   1. **Jira-style** (Given/When/Then with numbered steps) — for upload to Jira
   2. **ClickUp tasks** (description with checklist steps) — for upload to ClickUp
   3. **BDD (Gherkin)** — plain Gherkin for documentation or automation
   4. **Robot Framework** — .robot file format
   5. **Plain Markdown** — human-readable table format

   Default to the format matching `ticketSource.type` in qa-config.json if not specified.

3. **Generate test cases by category**
   Process the test plan's test scenarios and expand each into a full test case.

   For each test case, generate:
   - **ID** — sequential (e.g., TC-001, TC-002)
   - **Title** — imperative, specific (e.g., "User can submit order with valid credit card")
   - **Type** — Happy Path / Negative / Boundary / Regression / Security
   - **Priority** — High / Medium / Low
   - **Preconditions** — system state and data that must exist before the test
   - **Test Steps** — numbered, specific, actionable
   - **Expected Result** — observable outcome at each step and overall
   - **Test Data** — specific values needed (use placeholders like `{valid_email}`, `{invalid_card_number}`)
   - **Automatable** — Yes / No / Partial (whether this case is a candidate for e2e automation)

4. **Coverage: ensure all test types are represented**
   Aim for at minimum:
   - 1+ happy path tests per acceptance criterion
   - 1+ negative tests per input field or validation rule
   - Boundary tests for any numeric limits, length limits, or date ranges
   - 1 regression test linking to any known prior bugs in this area

5. **Save outputs**
   - `{testCasesDir}/{ticket-id}-test-cases.md` — human-readable markdown
   - `{testCasesDir}/{ticket-id}-test-cases.json` — structured JSON for upload

   JSON structure per test case:
   ```json
   {
     "id": "TC-001",
     "title": "...",
     "type": "happy-path",
     "priority": "high",
     "preconditions": "...",
     "steps": [
       { "step": 1, "action": "...", "expectedResult": "..." }
     ],
     "testData": { "key": "placeholder_value" },
     "automatable": true,
     "ticketId": "JIRA-123"
   }
   ```

6. **Summary**
   Report: total test cases generated, breakdown by type, count marked automatable. Say: "Run `/upload-tests {ticket-id}` to push these to {ticketSource.type}, or `/write-e2e-tests {ticket-id}` to automate the marked cases."

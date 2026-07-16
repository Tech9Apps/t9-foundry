# Create Manual Test Cases

You are given a ticket/work item ID: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, stop immediately and tell the user:**
> "A ticket ID is required. Usage: `/create-manual-test-cases <TICKET-ID>`"
**Do not proceed.**

## Prerequisites

The following files must exist:
- `tests/cases/.ticket-context/$ARGUMENTS.json` — ticket context (run `/fetch-ticket` first)
- `tests/cases/.ticket-context/$ARGUMENTS-analysis.md` — code analysis (run `/analyze-code` first)

If either is missing, tell the user which command to run first.

## Read Context

Read both the ticket context JSON and the code analysis markdown to understand the full picture.

## Generate Manual Test Cases

Write comprehensive manual test cases to `tests/cases/$ARGUMENTS.md` using this format:

```markdown
# Test Cases: <TICKET-ID> - <Ticket Title>

## Ticket Summary
<Brief summary>

## Module / Feature
<Which Project module>

## Preconditions
- <List preconditions>

## Test Cases

### TC-001: <Title>
- **Priority:** High / Medium / Low
- **Type:** Positive / Negative / Edge Case / UI Validation
- **Description:** <What this test verifies>
- **Steps:**
  1. <Step 1>
  2. ...
- **Expected Result:** <What should happen>
- **Selectors/Elements:** <Relevant UI elements from source code>
```

### Guidelines
1. **Cover all acceptance criteria** from the ticket
2. **Include positive tests** — happy path scenarios
3. **Include negative tests** — invalid inputs, error handling
4. **Include edge cases** — boundary values, empty states
5. **Include UI validation tests** — field validations, required fields, format checks
6. **Include role-based tests** — if the feature has RBAC, test with different roles
7. **Include API-level checks** — verify correct API calls and responses
8. **Reference actual selectors** from the source code (element IDs, labels, roles) so tests can be automated later
9. **Map each test case back to a requirement** from the ticket

## Output

Print:
- Number of manual test cases created
- File path for the created file

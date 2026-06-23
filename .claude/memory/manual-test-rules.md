# Manual Test-Case Rules

Read after `ai-usage-rules.md`. These govern manual test cases — the ones a
human executes by hand and the ones uploaded to Jira.

## What every manual test case must contain
- **Title** — concise, action-oriented (e.g. "Verify lead cannot be saved
  without a phone number").
- **Preconditions** — required state, role, and data before the steps begin.
- **Steps** — numbered, one action per step, written so any QA can follow them
  without guessing.
- **Test data** — the specific inputs used, or a reference to how to obtain
  them. No real customer data, no secrets.
- **Expected result** — observable and unambiguous, one per case where possible.
- **Traceability** — the ticket ID and the acceptance criterion it covers.

## Coverage rules
- Cover the **happy path, negative/validation paths, and edge cases** derived
  from the code (boundary values, empty/missing fields, permission/role
  differences, error states the code actually produces).
- One behavior per test case. Split rather than chaining unrelated assertions
  into a single case.
- Do not duplicate cases that already exist for the ticket — check first.

## Formatting and output
- Use the format reference in `templates/test-case-formats.md` and match the
  format already used in the project (Jira-style, Gherkin, plain markdown, etc.).
- Save to the configured `testCasesDir` (default `./test-cases/[ticket-id]-test-cases.md`)
  before uploading anywhere.
- Keep wording neutral and testable — avoid "should work", prefer the exact
  expected behavior.

## Uploading to Jira
- **Human review gate applies** (see `ai-usage-rules.md` §3). Present the table
  of cases and wait for approval before creating any Jira issue.
- Create test issues via the Atlassian MCP, link them to the parent ticket, and
  report the created keys back. Detect a "Test" issue type; fall back to "Task"
  if none exists.
- Never edit unrelated fields on the parent ticket.

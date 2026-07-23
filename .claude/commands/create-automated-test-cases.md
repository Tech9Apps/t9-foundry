# Create Automated Test Cases

You are given a ticket/work item ID: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, stop immediately and tell the user:**
> "A ticket ID is required. Usage: `/create-automated-test-cases <TICKET-ID>`"
**Do not proceed.**

## Prerequisites

The following files must exist:
- `tests/cases/.ticket-context/$ARGUMENTS.json` — ticket context (run `/fetch-ticket` first)
- `tests/cases/.ticket-context/$ARGUMENTS-analysis.md` — code analysis (run `/analyze-code` first)
- `tests/cases/$ARGUMENTS.md` — manual test cases (run `/create-manual-test-cases` first); automated tests are derived from these

If any is missing, tell the user which command to run first.

## Framework Check

Read `testFramework.type` from `qa-config.json`.
- **Unset**: stop and tell the user to run `/setup-e2e-framework` first.
- **Not `playwright`**: stop and tell the user this command only generates Playwright specs; point them to `/write-e2e-tests <TICKET-ID>` instead, which supports Cypress/pytest/RSpec/Selenium/WebDriverIO/Jest.

Follow `.claude/memory/automated-test-rules.md` — it is binding for this task.

## Read Context

Read the ticket context JSON, the code analysis markdown, and the manual test cases to understand what to automate.

## Generate Automated Playwright Tests

Write Playwright tests to `tests/<module>/<FeatureName>.spec.ts`:

- **Bug tickets**: max 2 consolidated tests
- **Story tickets**: max 4 consolidated tests
- Name the spec file after the **feature**, NOT the ticket ID
- Put the ticket ID in the `test.describe` block name and in `test()` names
- If a spec file for this feature already exists, **append** a new `test.describe` block — do not overwrite existing tests
- Create page objects under `pages/` for all UI interaction — keep selectors out of test bodies
- Selector priority: `data-testid` → ARIA role → accessible text (use the selectors recorded in the code analysis)
- No `sleep`/arbitrary waits — use Playwright auto-waiting and `expect(...).toBeVisible()` style assertions
- All environment values (base URL, credentials) from `process.env` / the config loader — never hardcoded
- Each test maps back to a manual test case ID (reference the TC-XXX in a comment or test title)

## Output

Print:
- Number of automated tests created
- Spec file path (and page object files created/updated)
- Mapping of automated tests to manual TC IDs

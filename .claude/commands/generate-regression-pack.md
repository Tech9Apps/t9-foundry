# Generate Regression Pack for a Module

You are given a module or feature-area name: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, blank, or not provided, stop immediately and tell the user:**
> "A module or feature-area name is required. Usage: `/generate-regression-pack <module>` (e.g. `/generate-regression-pack checkout` or `/generate-regression-pack user-management`)"
**Do not proceed with any further steps.**

No ticket is required — the regression pack is derived from the code itself.

## Prerequisites

Read `qa-config.json` first:
- **Source code location**: `codeRepository.localPath` — if unset or the path doesn't exist, stop and tell the user to run `/init` or `/switch-project <profile>` first.
- **Source-dir hints**: `codeRepository.sourceDirs` (fall back to discovering the repo structure if unset)
- **Output dirs**: `testOutput.testCasesDir` (default `./test-cases`)

Follow `.claude/memory/ai-usage-rules.md`, `manual-test-rules.md`, and `automated-test-rules.md` — they are binding.

## Scan the Module's Source

Locate everything under `codeRepository.localPath` belonging to the named module — same checklist as `analyze-code.md`:
- Routes/pages for the module and how a user reaches them
- UI components (forms, tables, modals, actions)
- Services/API endpoints the module calls
- Validation rules (schemas, form validation, required fields, boundaries)
- Role-based access controls affecting the module
- Success, error, and empty states the code actually handles

If the module name matches nothing in the repo, list the module-like areas you did find and ask the user to pick one — do not guess.

## Enumerate Regression Behaviors

From the scan, list every user-visible behavior the module currently supports. These — not any ticket — are the requirements the regression pack protects. For each behavior note: how to reach it, inputs, expected outcome, and role constraints.

## Generate the Regression Pack

**Manual regression cases** → `{testCasesDir}/regression/$ARGUMENTS-regression.md`
- Same TC format as `create-manual-test-cases.md` (TC-XXX, priority, type, steps, expected result, selectors)
- Cover happy paths, negative/validation paths, edge cases, role differences — one behavior per case
- Traceability line for each case: the source file(s) the behavior comes from

**Automated Playwright specs** → `tests/regression/$ARGUMENTS.spec.ts`

Check `testFramework.type` in `qa-config.json` first:
- **Not `playwright`** (including unset): skip this subsection — do not generate `.spec.ts` files. Tell the user this fast path only automates Playwright regression specs; point them to `/write-e2e-tests` for other configured frameworks. Manual regression cases above are unaffected and still generated regardless of framework.
- **`playwright`**: proceed —
  - One `test.describe('Regression: <module>')` block; each test maps to a TC-XXX
  - Page objects under `pages/`, `data-testid`-first selectors, no sleeps, env values from `process.env` only (per `automated-test-rules.md`)
  - Prioritize automating the High-priority cases; leave cases that genuinely need a human (visual judgment, third-party side effects) manual and mark them so

## Idempotent Re-runs — Update, Don't Regenerate

If a previous pack exists for this module:
1. Read the existing `$ARGUMENTS-regression.md` and `$ARGUMENTS.spec.ts`
2. Diff enumerated behaviors against existing cases
3. **Append** cases for new behaviors (next TC-XXX numbers), **flag** cases whose behavior no longer exists in code (mark `[STALE — verify and remove]`, don't silently delete), and leave still-valid cases untouched
4. Report what changed: added / stale / unchanged counts

## Output

Print:
- Module scanned and key source files read
- Number of manual regression cases (new/stale/unchanged if updating)
- Number of automated tests and the spec file path — or, if `testFramework.type` isn't `playwright`, that automation was skipped and why
- Which cases are manual-only and why
- File paths created or updated

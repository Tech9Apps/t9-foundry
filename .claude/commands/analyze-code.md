# Analyze Project Source Code for Ticket

You are given a ticket/work item ID: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, stop immediately and tell the user:**
> "A ticket ID is required. Usage: `/analyze-code <TICKET-ID>`"
**Do not proceed.**

## Prerequisites

The ticket context file must exist at `tests/cases/.ticket-context/$ARGUMENTS.json`. If it doesn't exist, tell the user to run `/fetch-ticket $ARGUMENTS` first.

## Read Ticket Context

Read `tests/cases/.ticket-context/$ARGUMENTS.json` to understand what the ticket is about.

## Analyze Project Source Code

Read `qa-config.json` first:
- **Project name**: `project.name`
- **Source code location**: `codeRepository.localPath` — if unset or the path doesn't exist, stop and tell the user to run `/init` or `/switch-project <profile>` first.

Based on the ticket content, identify which part of the application is affected.

Search the locations listed in `codeRepository.sourceDirs` (paths relative to `localPath`):
- **Frontend routes**: `sourceDirs.frontendRoutes` — find the relevant route/page
- **Frontend components**: `sourceDirs.components` — find the relevant UI components
- **Frontend services/API calls**: `sourceDirs.services` — find API/data-layer endpoints
- **Backend handlers**: `sourceDirs.backendHandlers` — find relevant backend handlers
- **Constants/roles**: `sourceDirs.constants`

**If `sourceDirs` is unset**, discover the structure yourself: inspect the repo layout (`ls`, framework config files, `package.json` workspaces) to locate routes, components, services, and backend handlers, then proceed with the same analysis.

Read the relevant source files to understand:
- What UI elements exist (buttons, forms, tables, modals, dropdowns)
- What user interactions are possible
- What API calls are triggered
- What validations exist (Zod schemas, form validations)
- What role-based access controls apply
- What success/error states are handled
- What selectors/locators can be used for Playwright (element roles, text, attributes)

## Save Analysis

Save the analysis to `tests/cases/.ticket-context/$ARGUMENTS-analysis.md` with:
- List of relevant source files read
- URL path(s) to reach the feature
- Key UI elements and their selectors
- Validation rules found
- API endpoints involved

## Output

Print a summary of:
- Which module/feature this ticket affects
- Key source files analyzed
- URL path to the feature
- Confirm analysis saved

# Post Test Cases

You are given a ticket/task/work-item ID: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, stop immediately and tell the user:**
> "A ticket ID is required. Usage: `/post-tests <TICKET-ID>`"
**Do not proceed.**

## Prerequisites

Read `qa-config.json > ticketSource.type` to determine the upload target. If `qa-config.json` is missing or `ticketSource.type` is unset, stop and tell the user to run `/init` or `/switch-project <profile>` first.

**Inline context override.** If the invoking agent supplied an already-resolved ticket source, `cloudId`, and `projectKey` (see Step 0 of `.claude/agents/Manual-test-generator.md`), use those in place of the config file and skip the missing-config stop above. When nothing is supplied inline, `qa-config.json` is required exactly as stated.

- Manual test cases at `tests/cases/$ARGUMENTS.md`. If missing, tell the user to run `/create-manual-test-cases $ARGUMENTS` first.
- Automated test spec file (find the relevant `.spec.ts` that contains a `test.describe` block with `$ARGUMENTS` in its name, if any)

> **Reference:** `.claude/guides/integration-sources.md` lists the upload method per target — update it if a method changes here.

**Which path a target takes:** `github`, `clickup` and `azure` are posted by `scripts/tracker/post-tests.js` (one tested, resumable command — see `docs/tracker-adapters.md`). `jira` is posted through the Atlassian MCP tools below. `none` posts nothing.

## Read Context

1. Read `tests/cases/$ARGUMENTS.md` to get all manual test cases
2. Read `tests/cases/.ticket-context/$ARGUMENTS.json` to get ticket context (skip if `ticketSource.type` is `none` — there is no context file)
3. Find and read the Playwright spec file that contains `$ARGUMENTS` in a `test.describe` block to get automated test cases (if any)

## Review Gate — Human Approval Required

Before posting anything to an external system, present the full list of test cases to the user for review. (Skip this gate only for `none` — nothing leaves the workspace in that case.)

### Present Test Cases for Review

Display a numbered table of all test cases that will be created:

```
## Test Cases for $ARGUMENTS — Review Before Posting

| # | TC ID | Summary | Priority | Type |
|---|-------|---------|----------|------|
| 1 | TC-001 | ... | High | Positive |
| 2 | TC-002 | ... | Medium | Edge Case |
...

Total: X test cases will be created in {ticket source}.
```

Then ask the user:

> **Please review the test cases above.** You can:
> - **Approve** — type `yes` or `approve` to proceed with posting
> - **Remove** — e.g. `remove TC-003, TC-007` to delete specific test cases
> - **Update** — e.g. `update TC-002 summary to "New title here"` to change a test case
> - **Add** — e.g. `add TC-017: Verify error toast when API fails` to add a new test case
>
> What would you like to do?

### Handle User Feedback

**Wait for the user's response.** Do NOT proceed to the external system until the user explicitly approves.

Process the user's feedback in a loop:

1. **Remove**: Delete the specified test cases from the list. Update the `tests/cases/$ARGUMENTS.md` file to remove them. Re-display the updated table.
2. **Update**: Modify the specified test case(s) in the list. Update the `tests/cases/$ARGUMENTS.md` file accordingly. Re-display the updated table.
3. **Add**: Add new test case(s) to the list with the next available TC-XXX number. Update the `tests/cases/$ARGUMENTS.md` file. Re-display the updated table.
4. **Approve**: Only when the user says `yes`, `approve`, `looks good`, `go ahead`, or similar confirmation — proceed to the next step.

After any remove/update/add action, re-display the updated table and ask for approval again. **Repeat until the user approves.**

## Post, by ticket source

### jira

**Idempotency check — before creating anything:** if `tests/cases/.ticket-context/$ARGUMENTS-test-keys.json` already exists from a prior run, read it first. For each TC-XXX already present with a remote ID recorded, skip re-creating it — show the user which TC-XXX already exist remotely and ask whether to skip them (default) or force-recreate. Only create/link test cases that are new or that the user explicitly asked to recreate. This avoids duplicate issues when a prior run partially failed and is being re-run. (The adapter-backed trackers below do this in code.)

**Resolve `cloudId` and `projectKey` first:** use the inline-resolved values if the invoking agent supplied them, otherwise read `ticketSource.jira.cloudId` / `ticketSource.jira.projectKey` from `qa-config.json`. Every `cloudId` / `projectKey` reference below means the resolved value.

**Then confirm the test issue type exists** before creating anything. Call `mcp__claude_ai_Atlassian__getJiraProjectIssueTypesMetadata` for the resolved `projectKey` and look for the type named by `ticketSource.jira.testIssueType` (default `Test`):
- Found → use that name as `issueTypeName`.
- Not found → fall back to `Task`, and **tell the user** you are doing so and why, before the review gate closes. Do not create dozens of issues under a type the project rejects.
- If the metadata call itself fails, say so and ask the user which issue type to use rather than guessing.

The issue link type has the same problem: if `createIssueLink` rejects the configured `linkType` (default `Test`), stop after the first failure, report it, and ask which link type to use — do not create the remaining issues unlinked without saying so.

Fetch the parent story/bug via `mcp__claude_ai_Atlassian__getJiraIssue`:
- `cloudId`: `<resolved cloudId>`
- `issueIdOrKey`: `$ARGUMENTS`
- `fields`: `["components", "fixVersions"]`

Extract **Components** (`fields.components`, use `id`) and **Fix Versions** (`fields.fixVersions`, use `id`) — copied to each Test issue.

Identify the assignee: use `mcp__claude_ai_Atlassian__atlassianUserInfo` to get the current (connected) user's `accountId`.

For **each** manual test case, create a Jira **Test** issue via `mcp__claude_ai_Atlassian__createJiraIssue`:
- `cloudId`: `<resolved cloudId>`
- `projectKey`: `<resolved projectKey>`
- `issueTypeName`: `<the type confirmed above — testIssueType, or Task if it was absent>`
- `summary`: `TC-XXX: <test case title>`
- `assignee_account_id`: `<accountId from atlassianUserInfo>`
- `additional_fields`: `{"components": [{"id": "<component-id-from-parent>"}], "fixVersions": [{"id": "<version-id-from-parent>"}]}`

**Create issues in parallel batches** (up to 8 at a time). Collect all created issue keys.

For **each** created Test issue, link it to the parent via `mcp__claude_ai_Atlassian__createIssueLink`:
- `cloudId`: `<resolved cloudId>`
- `inwardIssue`: `<created-test-issue-key>`
- `outwardIssue`: `$ARGUMENTS`
- `type`: `Test`

**Create links in parallel.** This populates the **Test Coverage** panel on the parent story/bug.

Save keys to `tests/cases/.ticket-context/$ARGUMENTS-test-keys.json`. Only include a test case here if its issue was actually created — a failed create has no `jiraKey` and isn't added. Record `linked: false` (not `true`) for a test case whose issue was created but whose link call failed, so a re-run can retry just the link instead of recreating the issue:
```json
{ "parentTicket": "$ARGUMENTS", "tests": [{ "tcId": "TC-001", "jiraKey": "<PROJECT-KEY>-XXXXX", "summary": "...", "linked": true }] }
```

### github / clickup / azure — via the tracker adapter CLI

Once the review gate is approved — and `tests/cases/$ARGUMENTS.md` reflects every remove/update/add the user asked for — post everything with one command:

```bash
node scripts/tracker/post-tests.js --parent $ARGUMENTS
```

It reads `tests/cases/$ARGUMENTS.md`, confirms the parent ticket exists and the credentials work (so a typo'd id creates nothing), then for every case creates the test item, links it to the parent, and records the outcome in `tests/cases/.ticket-context/$ARGUMENTS-test-keys.json`. You do not call the tracker yourself and you do not write the keys file by hand. Credentials come from the environment (`GITHUB_TOKEN`, `CLICKUP_TOKEN`, `AZURE_DEVOPS_PAT`, or `ticketSource.<type>.tokenEnvVar`) — never put a token on the command line or in a file. To preview without credentials or requests, add `--dry-run`.

**It is safe to run again.** Every case carries an idempotency key, so a re-run finds existing items instead of duplicating them, completes any item a previous attempt left half-built, and links anything that was created but not linked. Never run it twice at the same time.

Read the JSON it prints and report from it:

| Result | Meaning | What to do |
|---|---|---|
| `"ok": true` | Every case exists in the tracker and is linked. | Report the table (see Output). |
| `"ok": false` with a top-level `error`, no `tests` | It stopped **before creating anything**. | `NOT_FOUND` → the parent ticket is wrong; `UNAUTHENTICATED` / `FORBIDDEN` / `CONFIG` → tell the user exactly what is missing (`error.message`) and how to fix it; `VALIDATION` → the cases file is missing or empty (run `/create-manual-test-cases $ARGUMENTS`). Do not retry until the cause is fixed. |
| `"ok": false` with `failed` / `skipped` / `linkFailed` counts | Some cases did not make it. `tests[]` says which and why (`error.code`, `error.message`, `linkError`). | List the failing cases. If the errors are `retriable`, run the **same command again** — it resumes. `skipped > 0` means the run stopped early on a problem that would have hit every remaining case (revoked credentials, rate limiting): fix or wait first. To retry only some cases: `--only TC-003,TC-007`. |

Never re-create cases by hand and never tell the user to delete "duplicates" — re-running the command is the fix for every partial failure.

### none

No ticket system is configured — no remote upload is possible or attempted. The test cases are already saved as `tests/cases/$ARGUMENTS.md`; that is the sharable artifact. Report the file path and suggest sharing it with the team or importing it into a test management tool manually. Skip the "Save Created Test Keys" step — there is nothing remote to record.

## Output

- Confirm all test cases were posted (or, for `none`, confirm the file path)
- Print a table: TC ID | Remote ID | Summary | Status (created / already existed) — for the adapter-backed trackers take it from `tests[]` in the command's output
- Confirm links to the parent ticket/work item/task were created (GitHub references the parent in the issue body instead; not applicable for `none`)
- Print the counts: created, already existed, failed, skipped

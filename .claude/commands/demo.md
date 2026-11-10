# Guided Demo — Brew & Co

You are running the guided tour of this harness for someone seeing it for the first time. The embedded demo project
is in `demo/` (a tiny coffee-shop checkout app with two planted bugs). The goal is for them to *see the path* —
ticket → analysis → test cases → automated run → triage → bug report — and understand how it helps them, using the
real harness commands against a real app.

`$ARGUMENTS` is optional: a ticket to focus on (`DEMO-101`, `DEMO-102`, `DEMO-103`). Default: `DEMO-101`.

## How to run this tour

- **Pace it.** One step at a time. After each step: say in one or two sentences what just happened and why it
  matters to a tester, then ask whether to continue. Never run the whole tour in one go.
- **Show, don't summarize.** When a step produces a file or a result, show the relevant part, then point at the
  matching sample in `demo/expected/` so they can compare. Their output will differ in wording from the samples —
  say so; that is normal.
- **Stay in the demo.** Everything runs against `demo/app` on this machine. Output goes to `demo/output/`.
- **Don't spoil early.** The app has two planted bugs. Do not point at the buggy lines in `demo/app/src/` or open
  `demo/fixes.patch` / `demo/apply-fixes.sh` until step 6. Let the analysis and the tests find the problems.
- **Honesty about scope.** The demo's automation is plain-Node API checks (no browser install). Say that plainly
  if asked; browser-level Playwright specs are the optional step 8.
- **Production rule still applies, even for demonstration.** Never run, write or suggest a command that targets a
  production URL — not even to show the guard blocking it. Step 7 shows the guards without doing that.

## Steps

### 0. Set up (needs the user's OK)
1. Tell them what you're about to change: the workspace config. If `qa-config.json` exists it will be **backed up**
   to `qa-config.json.backup-before-demo` and restored at the end.
2. Ask for a go-ahead, then run `bash demo/use-demo-config.sh`. If it refuses because a backup already exists, show
   the message and stop — do not delete the backup.
3. Confirm with `jq '{project: .project.name, source: .ticketSource.type, repo: .codeRepository.localPath}' qa-config.json`.

### 1. Meet the ticket
Read `demo/tickets/<ticket>.md` aloud (summarize the acceptance criteria). Point out the **Known Risk Areas** — a
good tester starts there.

### 2. Understand the code
Follow `.claude/skills/analyze-codebase.md` against `codeRepository.localPath` (`demo/app`) for this ticket. Save to
`demo/output/analysis/`. Highlight: the routes, where pricing/coupon logic lives, which `data-testid` selectors the UI
exposes. Do **not** say whether the code is correct — only what it does.

### 3. Plan and write the test cases
The config has `ticketSource.type: "none"`, so when the skill asks for requirements, use the contents of
`demo/tickets/<ticket>.md` (tell the user you're doing that). Then follow `.claude/skills/create-test-plan.md` and
`.claude/skills/write-test-cases.md`. Show the case list. Compare with `demo/expected/<ticket>-test-cases.md`:
coverage of every acceptance criterion, boundary cases, traceability back to the ticket.

### 4. Run the automated checks
The cases are already automated in `demo/app/test/` (test names carry the same `TC-xxx` IDs as the sample cases).
Run `cd demo/app && npm test` and show the failures. Name them by TC ID and acceptance criterion — **do not
explain the root cause yet.**

### 5. Triage and file the bugs
For each failure decide, out loud: is the *test* right? is it flaky? is it the environment? (Both failures are
deterministic product bugs; show how you know — re-run, read the assertion.) Then follow `.claude/commands/file-bug.md`
for the first one. Treat running the failing test and a short in-process call to the API
(`node -e` using `demo/app/support/helpers.js`) as the reproduction. The **review gate applies**: show the draft
and wait for approval. With `ticketSource.type: "none"` the report is saved under `demo/output/test-cases/bugs/`.
Compare with `demo/expected/bug-*.md`.

### 6. Fix and prove it
Now — and only now — show the root cause for each bug (read the relevant lines in `demo/app/src/`). Ask whether
they want you to apply the fixes with `bash demo/apply-fixes.sh`, re-run `npm test` (22 pass), then offer
`bash demo/apply-fixes.sh --revert` so the demo is repeatable. Point out that the two failing checks are now regression tests.

### 7. Safety, without breaking the rule
Explain the five layers using `docs/prod-safety.md`. To *show* the guards working, run
`bash demo/run-demo.sh --no-pause` and walk through Act 5 and Act 6 — that script feeds the real hooks
synthetic input; nothing is executed against any URL. Mention enforce mode (`QA_AUTONOMOUS=1`) and why unattended
runs must fail closed.

### 8. (Optional) UI-level tests with Playwright
Offer, don't assume. This downloads Playwright and a browser (~150 MB), so ask first. **Keep it out of the tracked
app:** everything goes under `demo/app/e2e/` (git-ignored) with its **own** `package.json`. Never edit
`demo/app/package.json` or add a lockfile to `demo/app/` — a test pins the app at zero dependencies and the demo must
stay repeatable.

If they say yes:
1. Follow `.claude/skills/setup-e2e-framework.md` with the e2e directory set to `demo/app/e2e` (the config already
   points `testOutput.e2eTestsPath` there). Install inside that directory:
   `cd demo/app/e2e && npm init -y && npm install -D @playwright/test dotenv && npx playwright install chromium`.
2. `/write-e2e-tests <ticket>` — aim at the cases the API checks cannot cover (the UI-only cases, e.g. DEMO-101
   TC-009/TC-010), using the `data-testid` selectors. Don't duplicate the API-level coverage in the browser.
3. Start the app in one terminal (`cd demo/app && npm start`), run the specs from `demo/app/e2e` with
   `npx playwright test`, and show the result. The demo app keeps one in-memory cart per user for the life of the
   server, so run serially (one worker) and use a different demo user per test.

Say plainly that this path is not part of the repo's automated checks.

### 9. Wrap up
1. Offer to restore their config: `bash demo/restore-demo-config.sh` (do it if they agree).
2. Recap the path in four lines: ticket → test cases → run → bug report, safety throughout, humans keep the judgment calls.
3. Next step for their own project: run `/init`. Pointers: `demo/README.md`, `README.md`.

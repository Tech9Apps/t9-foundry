# The Demo: Brew & Co

A small, real project that lives inside the harness so you can *see the path* before pointing the tool at your own
work: **a ticket arrives → the harness reads the code → writes traceable test cases → runs them → triages the
failures → files the bugs**, with production safety enforced throughout.

The app is a tiny coffee-shop checkout (discount codes, tax and shipping, sign-in with lockout). It has two planted
bugs that the tests find. It runs entirely on your machine — no accounts, no tracker, no network.

## Pick your path

| I have… | Do this | You get |
|---|---|---|
| **2 minutes**, no Claude needed | `bash demo/run-demo.sh` | A narrated tour: a real ticket, real test cases, real test runs that find real bugs, the production guards blocking commands, a preflight check, and the fix proven green. Nothing in your tree is modified. |
| **15 minutes** and Claude Code | Open this repo in Claude Code and run `/demo` | The same story, but *you* drive the real commands (`/analyze-codebase`, `/create-test-plan`, `/write-test-cases`, `/file-bug`) against the app, one step at a time, comparing your output to the samples. |
| **5 minutes** to read | Browse [`demo/expected/`](expected/) | The artifacts a run produces: test cases, bug reports, a run report. |

Needs: `bash`, `node` ≥ 20, `jq`, `patch` for the tour; [Claude Code](https://claude.ai/code) for `/demo`.
No `npm install` anywhere — the app has zero dependencies.

> **Spoiler warning.** The tour, `expected/bug-*.md`, `fixes.patch` and `apply-fixes.sh` reveal the planted bugs.
> To hunt blind, run `/demo` and let it find them for you.

## The story

Three tickets ([`tickets/`](tickets/)) written the way a team really writes them — acceptance criteria and a
"known risk areas" section:

| Ticket | Feature | What a good tester worries about |
|---|---|---|
| DEMO-101 | Apply a discount code | "One code per order" must be enforced server-side |
| DEMO-102 | Order total, tax, free shipping | The $50 free-shipping line *interacts with* discounts |
| DEMO-103 | Sign in with account lockout | Time-dependent logic and the 15-minute boundary |

Then the path, and what each step is worth to you:

| Step | What happens | Harness command | Why it helps |
|---|---|---|---|
| 1. Read the ticket | Acceptance criteria and risk notes become the spec | `/fetch-ticket` (or paste, when there is no tracker) | Tests start from requirements, not guesses |
| 2. Understand the code | Routes, validation, selectors, API calls are mapped | `/analyze-codebase` | Test cases reference what the code *actually* does |
| 3. Write test cases | Positive, negative, boundary and UI cases, each traced to an acceptance criterion | `/create-test-plan`, `/write-test-cases` | Coverage you can audit; nothing skipped quietly |
| 4. Run automation | Cases run against the app | `/run-tests`, `/write-e2e-tests` | Fast, repeatable feedback |
| 5. Triage | Is the test wrong, flaky, the environment, or a real bug? | (judgment, assisted) | The hours testers actually spend |
| 6. File the bug | Steps, expected vs actual, evidence, severity, suspected area | `/file-bug` | A report a developer can act on without a meeting |
| 7. Stay safe | Five guard layers keep tests off production | hooks, `scripts/preflight.sh` | You can let it run with confidence |

## What to notice

- **Traceability.** Every case names its acceptance criterion; every automated check carries the same `TC-xxx` ID as
  its manual twin ([`expected/DEMO-101-test-cases.md`](expected/DEMO-101-test-cases.md) ↔
  [`app/test/discount-codes.test.js`](app/test/discount-codes.test.js)).
- **Risk-targeted testing.** The two bugs hide exactly where the tickets' "known risk areas" pointed. Passing
  boundary cases sit right next to the failing one — that contrast is what tells you where the defect really is.
- **Triage, not just red/green.** See [`expected/run-report.md`](expected/run-report.md): both failures are classified
  and written up, and the humans still decide whether they block the release.
- **Safety is mechanical.** The guards are shell hooks and runtime checks that run whether or not anyone is paying
  attention — see `docs/prod-safety.md`.

## Run the app yourself (optional)

```bash
cd demo/app
npm start                  # http://localhost:4173
npm test                   # 22 checks: 20 pass, 2 fail (the planted bugs)
```

Sign in with `ada@brewandco.test` / `espresso123`. The UI uses `data-testid` attributes throughout, so browser
tests (Playwright via `/setup-e2e-framework` + `/write-e2e-tests`) have stable hooks to aim at.

Repeat the demo any time:

```bash
bash demo/apply-fixes.sh            # fix the bugs   → npm test is green
bash demo/apply-fixes.sh --revert   # break them again
bash demo/restore-demo-config.sh    # after /demo: put your own qa-config.json back
```

## What's real, and what's simplified

Real: the hooks and guards, `scripts/preflight.sh`, the app and its bugs, the test runs, the harness commands you
drive in `/demo`. Simplified, on purpose:

- **No ticket system.** The demo config uses `ticketSource.type: "none"`, so test cases and bug reports are saved as
  files (under `demo/output/`, git-ignored). With Jira, Azure DevOps, ClickUp, GitHub, GitLab or Bitbucket connected,
  the same cases are uploaded and bugs are filed there — after your approval.
- **API-level automation.** The automated checks call the app's API in-process (plain `node --test`) so the demo
  needs no browser download. Real projects usually add browser tests; `/demo` step 8 generates them (installed under the
  git-ignored `demo/app/e2e/`, never in the app's own `package.json`). Optional, and not part of the repo's automated checks.
- **Sample outputs are illustrative.** [`expected/`](expected/) shows the *shape and quality bar* of generated
  artifacts. Your run will word things differently — that's fine.

## Layout

```
demo/
├── README.md                this file
├── run-demo.sh              the 2-minute tour (no install, no AI)
├── qa-config.demo.json      workspace config for the demo project (installed by /demo, with a backup)
├── use-demo-config.sh       install the demo config (backs up yours)   restore-demo-config.sh  undo it
├── apply-fixes.sh           spoiler: fix / re-break the planted bugs   fixes.patch  the two one-line fixes
├── tickets/                 DEMO-101 … DEMO-103
├── expected/                sample outputs: test cases, bug reports, run report
└── app/                     Brew & Co — zero-dependency Node app, its tests, a small browser UI
```

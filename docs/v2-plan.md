# tech9foundry v2 — Toward a Fully Agentic Tester

**Status:** Draft for review (not implemented). Baseline: `main` @ PR #6, 73 bats tests passing.

## Goal

v1 is a guarded assistant: a human types a slash command, the AI does one pipeline stage, a human approves every external write.
v2 closes the loop. An **event** (ticket moves to Ready for QA, PR opens, nightly schedule) triggers a run that
**generates → executes → triages → acts** (post results, file bugs, propose test fixes) and a human only sees exceptions.

**Acceptance scenario (definition of done for v2):** against a sandbox tracker and staging app, with no human at the keyboard —
ticket enters "Ready for QA" → manual + automated tests are generated and posted → suite runs → a seeded product bug is
classified, deduplicated, and filed with evidence → a seeded stale selector is fixed on a branch with a PR → results are posted
to the ticket and Slack → flipping the kill switch halts the next run. All of it replayable in CI against mocks.

## Principles

1. **Verify before you autonomize.** No human gate is removed for an action until that action has deterministic tests (mocks) and an eval.
2. **Unattended means fail-closed.** Warnings nobody reads are not guards. In autonomous mode every safety layer blocks.
3. **Autonomy is configuration, not code.** Per-action tiers (`off | propose | auto`), enforced by hooks, not by prompt wording.
4. **Everything leaves a trail.** Every autonomous action is recorded (ledger), idempotent, and reversible or at least attributable.
5. **v1 behavior is the default.** New capability ships off by default; interactive users see no change until they opt in.

## Findings from the v1 review that shape the plan

These are things I verified while reading the repo for this plan — they are why Phase 0 exists.

| # | Finding | Why it matters for v2 |
|---|---------|-----------------------|
| F1 | `.claude/settings.json` hook commands are relative (`bash hooks/prod-guard.sh`). | If a headless run starts with any cwd other than the harness root, **the hooks never run** — Layers 2–4 silently absent. |
| F2 | The `permissions.allow` curl rules match `curl -s -H …`. PR #5 changed every curl to `curl -fsS --max-time 30 …`. | Those commands no longer match the allowlist → **permission prompts that deadlock an unattended run**. This is a regression from PR #5 (mine). Azure `-u`, `gh issue comment`, and `gh pr` calls were never allowlisted. |
| F3 | Layers 3/4 only *warn* on the suspicious-URL heuristic; Layer 2 only warns on empty `prodUrlPatterns`. | Fine with a human watching; meaningless unattended. |
| F4 | pytest/RSpec/Selenium Layer 5 guards have no suspicious-URL heuristic (TS templates do). Bitbucket bug filing assumes token-only auth; no username field. | Inconsistent safety floor across frameworks; Bitbucket likely broken. |
| F5 | Jira access is via the Atlassian **MCP connector** (OAuth). | CI/headless runs cannot use claude.ai connectors → headless Jira needs a REST/API-token path. |
| F6 | PR #6 added **inline mode** to `Manual-test-generator` (Jira key + codebase path, no `qa-config.json`). | Deliberately manual-only because it has no prod patterns. The autonomy design must keep that boundary: inline context must never reach execution or automated generation. |
| F7 | Tracker I/O (fetch/post/comment/bug) is ~400 lines of curl prose duplicated across 3 command files. | Not unit-testable, not mockable, drifts (this is how the Jira-only Step 6 bug happened). |
| F8 | `run-spec-tests` parses `--reporter=list` text and is Playwright-only; no handoff to `file-bug`; state lives in scattered `tests/cases/.ticket-context/*.json`. | Blocks triage, flake detection, idempotency, and trend data. |

## Phase 0 — Safety floor and regressions *(small; 1 PR; do first)*

Fix what is wrong today and make unattended runs *safe to attempt*.

- **Hooks resolve from `$CLAUDE_PROJECT_DIR`** in `.claude/settings.json` (F1). Add a bats test that parses `settings.json` and asserts every hook path exists.
- **Repair the allowlist** (F2): patterns for the new curl flag set, Azure (`-u`), `gh issue comment/create`, and a **lint test** that extracts every `curl`/`gh` line from `.claude/commands/*.md` and asserts it matches an allow rule (extends the existing `wording-lint.bats`).
- **Enforce mode** (F3): `productionProtection.mode: "warn" | "enforce"` in the schema. `QA_AUTONOMOUS=1` forces `enforce`. In enforce:
  suspicious-URL heuristic **blocks** (exit 2); empty `prodUrlPatterns` **blocks the session**; missing/unresolvable `qa-config.json` blocks (except the explicit inline-mode carve-out, F6).
  Interactive default stays `warn` (v1 behavior).
- **`scripts/preflight.sh`**: `QA_HARNESS_DIR` valid, config validates against schema, `prodUrlPatterns` non-empty, staging URL reachable and not matching a prod pattern, required token env vars set, `jq`/`claude` present. Exit non-zero with a fix hint. Runs at the start of every autonomous run.
- **Close F4**: heuristic in pytest/RSpec/Selenium guards; `ticketSource.bitbucket.username` (+ schema, session-init check, `file-bug.md` auth).
- **Exit criteria:** hooks fire from a foreign cwd (bats test); no unmatched curl/gh line; `enforce` blocks each of the three cases (bats); all 73 existing tests still pass.

## Phase 1 — Make the harness verifiable *(large; prerequisite for everything below)*

1. **Tracker adapters (F5, F7).** Replace curl prose with `scripts/tracker/<source>` commands behind one JSON contract:
   `fetch <id>`, `search <query>`, `create-test`, `link`, `comment`, `create-bug`, each emitting/consuming JSON validated by schemas in `schemas/`.
   `.claude/commands/*.md` shrink to "call the adapter" (still branch-free). Sources: azure, clickup, github, gitlab, bitbucket (REST) and **jira via REST + `JIRA_API_TOKEN`** for headless; the MCP path stays for interactive Jira.
2. **Mock trackers** in `tests/mocks/` (small Node HTTP servers, one per REST source) with failure injection: 404, 500, timeout, partial batch failure, duplicate create. Adapter bats tests run against them in CI.
3. **Artifact schemas** (`schemas/*.schema.json`): ticket context, test-keys, bug receipt, run result, ledger record. Validate in tests and at runtime.
4. **Structured test results.** `scripts/run-tests.sh <framework>` runs the suite with a JSON reporter (Playwright `json`, Cypress mochawesome/JUnit, pytest `--junitxml`, RSpec JSON formatter, WDIO JSON) and `scripts/normalize-results.js` emits one `run-result.schema.json` document. Replaces `--reporter=list` scraping and the Playwright-only restriction.
5. **Evals** (`evals/`): 3–5 golden tickets + a tiny sample app repo + expected-property assertions (TC count range, artifact schemas valid, correct adapter calls recorded by the mock, checkpoints present, prod-guard untouched). Runner `scripts/eval.sh` uses `claude -p … --output-format json` against mocks. Deterministic assertions run on every PR; the model-calling eval runs nightly and on demand (cost).
- **Exit criteria:** every tracker branch exercised in CI against a mock with at least one injected failure; one golden ticket passes end-to-end per source; results normalize for all supported frameworks.

## Phase 2 — Close the loop: run → triage → act *(medium)*

- **`QA-run-orchestrator` agent**: `preflight → run → re-run failures ×N → classify → act → report`.
- **Failure classification** with a binding rubric `.claude/memory/failure-triage-rules.md`: `product-bug | test-bug | flaky | environment`. Evidence rules (e.g. passes on re-run ⇒ flaky; locator-not-found with element present under a different testid ⇒ test-bug; 5xx/connection refused/preflight failure ⇒ environment). The classifier returns a confidence and cites evidence; low confidence ⇒ `propose` regardless of tier.
- **Bug filing handoff** to `file-bug` for `product-bug` only, with a **fingerprint** (spec + title + normalized error signature) and `tracker search` for an existing open bug first — comment on it instead of duplicating.
- **Self-heal for `test-bug`**: changes limited to page objects/selectors/waits, committed to `qa/heal-<run-id>`, validated by re-run, opened as a PR — **never pushed to the default branch**, hard attempt cap, never edits assertions.
- **Flake handling**: tests that flip pass/fail across re-runs are tagged and reported, not filed.
- **Exit criteria:** seeded scenarios in the sample app (real bug, stale selector, flaky test, env outage) each end in the correct classification and action, in CI, against mocks.

## Phase 3 — State, idempotency, observability *(medium)*

- **Run ledger** (`.qa-ledger/`, JSONL or SQLite — see Decisions): runs, per-test results, flake rates, bug fingerprints, idempotency keys, autonomous-action audit log. Replaces ad-hoc `.ticket-context` receipts (kept as a compatibility read path).
- `post-tests` and `file-bug` become idempotent via ledger keys (supersedes the v1 "check the keys file" prose); crash-safe resume.
- **Reporting**: `scripts/report.sh` → markdown run summary (ticket comment + GitHub step summary) and optional Slack webhook (`QA_SLACK_WEBHOOK`); failure-only channel option.
- **Budgets and locks**: per-run `maxTurns`, `maxCostUsd`, wall-clock timeout; a lock so two runs don't hit the same environment/ticket; per-ticket cooldown.
- **Exit criteria:** re-running the same ticket twice creates zero duplicates (mock-verified); killing a run mid-batch and resuming completes without duplicates; summary renders for pass/fail/error.

## Phase 4 — Autonomy tiers and triggers *(medium)*

- **`autonomy` block** in `qa-config.json` (schema v2, `schemaVersion: 2`; v1 configs remain valid and map to all-`propose`):
  ```json
  "autonomy": {
    "dryRun": false,
    "actions": {
      "draftTests": "auto",
      "postTests": "propose",
      "postResults": "auto",
      "fileBug": "propose",
      "healTests": "propose"
    }
  }
  ```
  `off` = never; `propose` = write the plan to `.qa-ledger/proposals/` and request approval (ticket comment / PR comment / Slack); `auto` = act, then audit.
- **Enforced by a new PreToolUse hook**, not by prompt instructions: external-write commands (adapter `create-*`/`comment`, `git push`, `gh pr create`) are denied unless the action's tier allows it. This is what turns today's prompt-level review gates into real policy.
- **Kill switch**: `QA_KILL=1` or a `.qa-halt` file (also checkable remotely by the CI workflow) stops new runs and blocks writes in running ones.
- **Entry point**: `scripts/run-autonomous.sh <ticket|nightly|pr> <id>` → exports `QA_AUTONOMOUS=1`, runs preflight, invokes headless `claude -p` with `--max-turns`, an explicit allowlist (not a permission bypass), and `--output-format json`; exit codes map to pass / test-failures / harness-error / halted.
- **CI templates** in `templates/ci/`: `qa-on-ticket.yml` (repository_dispatch from a tracker webhook), `qa-nightly.yml`, `qa-on-pr.yml`; extend `/setup-ci` to install them. Secrets stay as env-var names.
- **Inline-mode boundary (F6)**: the hook refuses any execution/automated-generation action when the active context was resolved inline. Add a bats test.
- **Exit criteria:** with every tier `off`, the autonomous run can only read; `propose` produces a proposal and writes nothing remote; `auto` writes and logs; the kill switch halts a run mid-flight (mock-verified). Then the **acceptance scenario** runs green in CI.

## Phase 5 — Exploratory testing and coverage intelligence *(stretch; only after 1–4 are trusted)*

- Exploratory agent using a browser MCP, constrained to `testEnvironmentBaseUrl`, with the same prod guards, a step/time budget, and findings routed through the Phase 2 classifier (it can only *propose* bugs initially).
- Change-driven coverage: diff → affected modules → missing/stale tests (builds on `/catchup-e2e` and `/generate-regression-pack`).
- Quarantine policy driven by ledger flake rates; auto-unquarantine after N clean runs.

## Delivery

- **Trunk, not a long-lived v2 branch.** One PR per phase; everything new is off by default, so `main` stays releasable and Nayan's inline-mode work keeps landing without a merge war. Tag `v2.0.0` when the acceptance scenario is green.
- **Suggested ownership** (adjust with Nayan): Phase 0 — Jason (fixes his own PR #5 regression); Phase 1 tracker adapters/mocks — Nayan (he built the agent/command pipeline and Jira flow); Phase 1 evals/results normalization and Phase 2 — Jason; Phases 3–4 paired.
- **Docs:** `docs/autonomy.md` (tier model, kill switch, runbook), update `docs/prod-safety.md` for enforce mode, README "Autonomous mode" section, `CLAUDE.md` Architecture.
- **Migration:** `/init` and `/reconfigure` learn the `autonomy` and `productionProtection.mode` fields; schema stays backward compatible.

## Risks

| Risk | Mitigation |
|------|-----------|
| Autonomous run files wrong/duplicate bugs | Fingerprint + tracker search, `propose` default for `fileBug`, ledger audit, kill switch |
| Self-heal masks a real regression by "fixing" the test | Selector/wait-only scope, never touches assertions, PR not push, requires re-run pass, classifier confidence gate |
| Runaway cost/loops | `maxTurns`, `maxCostUsd`, timeout, lock + cooldown |
| Unattended run reaches production | `enforce` mode, preflight, fail-closed hooks, Layer 5 in every framework, inline-mode boundary |
| Headless Jira divergence from MCP path | Same adapter contract + shared mock tests; MCP stays interactive-only |
| Eval cost / LLM nondeterminism | Deterministic structural assertions on every PR; model-calling evals nightly with tolerance bands |
| Scope creep into Phase 5 | Phase 5 is explicitly gated on the acceptance scenario |

## Decisions needed

1. **Headless Jira:** REST + API token adapter (recommended) vs. requiring an MCP-capable runner. Needs a service account / token owner.
2. **Ledger format:** JSONL files (zero deps, diffable, recommended to start) vs. SQLite (queries, trend data; adds a dependency). Committed to the repo, gitignored, or stored as a CI artifact?
3. **Trigger hosting:** GitHub Actions only (recommended — already used for CI) vs. a small always-on service for ticket webhooks.
4. **Initial tier defaults for the pilot project:** recommended `draftTests=auto`, `postResults=auto`, everything else `propose`, loosen after N clean runs.
5. **Self-heal in v2.0 or deferred to v2.1?** It is the highest-risk autonomous action; deferring it still satisfies "fully agentic" for run/triage/report/file.
6. **Which pilot project/tracker/staging** do we run the first real autonomous cycle against?

## Recommended first cut

Phase 0 as a single PR (it fixes a live regression and is prerequisite safety), then Phase 1 steps 1–3 (adapters, mocks, schemas) in parallel with step 4–5 (results normalization, evals).
Roughly: Phase 0 small, Phase 1 large (the bulk of v2's risk reduction), Phases 2–4 medium each, Phase 5 optional.

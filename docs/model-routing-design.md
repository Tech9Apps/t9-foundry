# Model routing: spending tokens where they buy something

**Status:** Proposed (design only, no code). Written 2026-11-23 after Phase 3 was built. It belongs to Phase 4, whose launcher is where it
runs; its first two slices need none of Phase 4 and can land before it. Follows the "design doc first" rule in
[v2-plan.md](./v2-plan.md#delivery): this merges before any code.
References to the run ledger, `ledger budget-check` / `budget-record`, `report.js` and the `budget` block are to Phase 3 as built in PR #13
(in review when this was written).

## What this is for

Today every agent in the harness is pinned to the most expensive tier:

| Agent | `model:` | `maxTurns` |
|---|---|---|
| `QA-run-orchestrator` | `opus` | 60 |
| `Bug-reporter` | `opus` | 50 |
| `Manual-test-generator` | `opus` | 50 |
| `Manual-Automation-test-generator` | `opus` | 50 |
| `Regression-pack-generator` | `opus` | 50 |

That was the right default for a v1 where one model did everything. It is not right for v2, where **code already decides most of what
a run does** (`orchestrate.js` runs, re-runs, classifies and plans; `report.js` writes the summary; self-heal is a deterministic rename)
and a model is needed only for a few narrow jobs. The question is not "which model is best" but **"what is the cheapest way to get each
job done to the bar that job needs, and how do we know?"**

Per-token list prices (Anthropic first-party API, as of 2026-11-03; confirm before relying on them):

| Model | Input $/MTok | Output $/MTok | Relative to Opus 5.5 |
|---|---|---|---|
| Opus 5.5 | 4.00 | 20.00 | 1× |
| Sonnet 5.5 | 2.00 | 10.00 | 0.5× |
| Haiku 5.5 | 0.10 (0.50 over 100K tokens) | 0.50 (2.50 over 100K) | 0.025× (1/40) |

These are **per token, not per task**: a cheaper model that needs more turns, or a retry, can cost more per finished job. Every decision
below is judged per completed stage, and measured (see "Recording and tuning").

### The levers, in the order they pay

1. **Do not call a model when code can decide.** A green run, a run whose failures are all report-only, and every ledger/report/plan step
   need no model at all. This is the biggest lever and it is free.
2. **Right-size the model per stage**, with a deterministic check that the cheaper choice worked, and an escalation when it did not.
3. **Right-size effort.** `claude --effort low|medium|high|xhigh|max` is a second dial on the same model. The API reference's own advice
   is to measure "the most capable model at lower effort" *before* building a cascade, because lower effort on the newest models often
   matches older models at high effort, and **prompt caches are model-scoped**, so switching models forfeits cache reuse. The router
   therefore chooses a `(model, effort)` pair, not just a model.
4. **Narrow what each call sees and can do.** One small headless call per job, with only the files it needs and a minimal tool
   allowlist, instead of one 60-turn agent session that carries everything.
5. **Cap it.** `--max-budget-usd` per stage and a run total from the Phase 3 `budget` block; `--max-turns` as a second cap (see the note
   on that flag under "Limits").

## Decisions taken (proposed; the open questions are at the end)

| # | Decision | Why |
|---|---|---|
| 1 | **The router is deterministic code, not a model.** `route(stage, signals, policy, history) → { model, effort, maxTurns, maxBudgetUsd, reasons }`. | A model router costs tokens to save tokens, cannot be unit-tested, and can be steered by ticket text (prompt injection). Every input it needs is measurable by code. |
| 2 | **Choosing a model never grants permission.** Autonomy tiers and the PreToolUse hook (Phase 4) still decide what may be written, pushed or filed. | Keeps two concerns apart: cost routing is advisory to the launcher, authority is enforced by hooks. |
| 3 | **A floor by authority.** A stage that can write to a tracker, edit a file or start another agent never runs below `models.floors.<stage>` (default Sonnet). A flag can raise a floor, never lower it. | The orchestrator and Bug-reporter follow long binding policy prose (`.claude/memory/*`, pinned by hash); a weaker model following it less reliably is a safety cost, not a saving. Same rule as the Phase 3 budget flags: flags tighten, never loosen. |
| 4 | **Escalate on a failed check, never on the model's own say-so.** One step up per stage per run, at most. | A model's confidence in itself is the one signal that does not cost anything to fake. A schema check, a parse, a file that exists, a locator the page really has: those are evidence. |
| 5 | **When the router is unsure, it picks the stage's configured default, never a cheaper one.** Fail-safe for a cost decision means "spend", not "skip". | Principle 2 of the plan (unattended means fail-closed), applied to cost. |
| 6 | **Off by default.** With no `models` block in `qa-config.json`, nothing changes: agents keep their frontmatter, the launcher uses what it does today. | Principle 5 of the plan. |
| 7 | **Every decision is recorded.** A `route` event in the run ledger (stage, model, effort, reasons, attempt) and the spend in the existing `budget` events, shown in `report.js` as "Model use". | So tuning is done from data, and "not measured" stays honest. |
| 8 | **Defaults for judgement stages are not lowered until an eval says so.** Mechanical stages start cheap now. | Evidence before downgrade: the plan's first principle ("verify before you autonomize") applies to saving money too. |

## The process

An autonomous run, from the launcher's side (Phase 4's `run-autonomous.sh`, or a person running `scripts/route/run.js` by hand):

```
 1. preflight                       code          (existing)
 2. lock + cooldown + budget-check  code          (Phase 3: ledger budget-check, exit 4 = refuse)
 3. orchestrate.js                  code          (run, re-run, classify, plan; records the ledger)
      status: green        ->  report.js, done.                         NO MODEL STARTED
 4. decide what needs a model       code          (read triage.json / plan.json, see "Stages")
      nothing does         ->  report.js, done.                         NO MODEL STARTED
 5. for each stage that does:
      route(stage, signals)         code          -> model, effort, caps, reasons   [ledger: route]
      claude -p ... one narrow call model         with only that stage's inputs and tools
      validate the output           code          (schema, parse, file, locator ...)
      failed + not yet escalated    ->  route(stage, attempt 2)  one tier up, same caps pool
      failed again                  ->  stop the stage, say so; never retry a third time
      budget-record the spend       code          [ledger: budget]
 6. report.js                       code          the summary shows model use per stage
```

Steps 3, 4 and 6 are the point. In the common case (a green nightly run) the model bill is **zero**. Nothing here is new machinery for
steps 1 to 3 and 6: they exist.

### Stages, and what each starts at

"Starts at" is the proposed default; the policy is configuration (below), and the escalation target is always the next tier up.

| Stage | Needs a model? | Starts at | Check that decides it worked | Escalates to |
|---|---|---|---|---|
| Preflight, run, re-run, classify, plan, flake rate, report, lock/cooldown | No: code | none | n/a | n/a |
| Self-heal | No: deterministic rename | none | existing validation re-run | n/a |
| Comment text for an existing report | No: the planner writes `commentInput.body` | none | n/a | n/a |
| **Evidence capture** for a verdict that needs it (`LOCATOR_NO_EVIDENCE`, `NOT_RERUN`) | Yes, mechanical: print a page's HTML to a file | Haiku, `low` | file exists, is HTML, within size bounds, and `locators.js` accepts it | Sonnet |
| **Bug filing** (`Bug-reporter`: title, steps, expected/actual, evidence; behind the human review gate) | Yes | Sonnet, `medium` | bug receipt schema valid, fingerprint marker present, evidence attached | Opus, `high` |
| **Manual test cases** from a ticket | Yes | Sonnet, `medium`; Opus when the ticket is large (see signals) | test-case schema valid, count within the expected range, every acceptance criterion mapped to a case | Opus, `high` |
| **Automated test code** from cases | Yes | Sonnet, `medium` | file parses, selectors exist in the code, the runner lists the tests | Opus, `high` |
| **Regression pack** for a module | Yes | Sonnet, `high`; Opus above a module-size signal | as above, plus no case without a selector | Opus, `high` |
| **Orchestrator narration** (reading `triage.json`/`plan.json` and reporting) | **No, when `report.js` covers it**; Sonnet otherwise | none / Sonnet | n/a | n/a |

Two observations behind that table:

- The `QA-run-orchestrator` agent exists because choreography used to be prose. `orchestrate.js` took the choreography; what is left
  for a model there is gathering evidence and handing a bug over. **Splitting those into separate narrow calls** is what lets the
  mechanical part run on a cheap tier while the part that follows policy prose keeps a floor.
- Nothing in this table lets a model re-label a verdict or promote a `propose`. Those remain code (`classify.js`) and are out of scope.

### Signals the router reads (all computed by code)

| Signal | From | Used for |
|---|---|---|
| stage, attempt number | the launcher | which row, and whether this is an escalation |
| ticket size (characters, acceptance-criteria count, linked tickets) | the fetched ticket | test generation: Sonnet or Opus |
| module size (files, lines) | the code scan | regression pack |
| number and class of failures needing evidence | `triage.json` | whether a stage runs at all, and how many calls |
| format cap (`unverified-format`) | `triage.json` | held at `propose`: no filing stage runs |
| autonomy tier for the action | `autonomy` block (Phase 4) | `off` means the stage does not run; `propose` means it drafts only |
| budget left (`maxCostUsd`, `maxWallClockMs`) and the stage's share | `ledger budget-check` | cap per call, and refusing a stage that cannot finish |
| history: per stage and model, validator pass rate, escalation rate, mean cost | the ledger, once there are enough runs | choosing the cheaper start only where it has held (report-only first) |

### Escalation, precisely

- Trigger: the stage's validator fails, **or** the call hits its own cap (`max_budget` or turns) without finishing. Nothing else.
- One step up (Haiku to Sonnet, Sonnet to Opus), at most once per stage per run. A second failure ends the stage and is reported:
  "bug filing failed validation on Sonnet and Opus; nothing was filed", in the summary's "Not done, and why".
- The escalated call draws from the same stage budget; if what is left cannot cover it, the stage stops instead of overspending.
- `claude --fallback-model` is a different tool (availability when a model is overloaded) and is not used for quality escalation.

## Configuration

One new optional block in `qa-config.json` (schema stays backward compatible; absent means today's behaviour):

```json
"models": {
  "default": { "model": "sonnet", "effort": "medium" },
  "stages": {
    "evidence":     { "model": "haiku",  "effort": "low" },
    "bugFiling":    { "model": "sonnet", "effort": "medium", "escalateTo": { "model": "opus", "effort": "high" } },
    "testCases":    { "model": "sonnet", "effort": "medium", "escalateTo": { "model": "opus", "effort": "high" } },
    "testCode":     { "model": "sonnet", "effort": "medium", "escalateTo": { "model": "opus", "effort": "high" } },
    "regressionPack": { "model": "sonnet", "effort": "high", "escalateTo": { "model": "opus", "effort": "high" } }
  },
  "floors": { "bugFiling": "sonnet", "testCode": "sonnet", "orchestrator": "sonnet" },
  "prices": { "asOf": "2026-11-03", "opus": [4, 20], "sonnet": [2, 10], "haiku": [0.1, 0.5] }
}
```

- Model names are the CLI aliases (`haiku`, `sonnet`, `opus`) or a full id from an allowlist; anything else is a usage error naming the key.
  `fable` / `mythos` are not in the default allowlist (priced above Opus); a project must add them deliberately.
- The resolved model id is recorded in the ledger so a run can be reproduced even when an alias moves.
- `prices` is used **only to estimate** spend and to decide whether a stage fits what is left of a budget. The hard cap is Anthropic-side
  (`--max-budget-usd`), so a stale price table can make an estimate wrong but cannot make a run overspend.
- Flags can tighten (a lower budget, a higher floor, a more capable model) and never loosen, as with the Phase 3 `budget` flags.

## Recording and tuning

- **Ledger:** a new `route` record (`stage`, `model`, `effort`, `attempt`, `reasons[]`, `maxBudgetUsd`), and the existing `budget` record
  per call (turns, cost, wall clock; today written by `ledger budget-record`). The launcher writes both; the scripts never guess spend.
- **`ledger route-stats`:** per stage and model: runs, validator pass rate, escalation rate, mean cost, mean turns. Read-only.
- **`report.js`** gains a "Model use" section: each stage, the model and effort it ran on, whether it escalated and why, and what it cost
  (or "not measured").
- **Learning is report-only at first.** The router may start a stage one tier cheaper than its default only when `route-stats` shows a
  pass rate above a configured threshold over a configured window, and never below a floor. Until there is data, the configured default
  stands. Changing a *shipped* default needs an eval (below), not just stats.

## Where it runs

- **Autonomous runs (Phase 4):** the launcher calls the router and starts each stage with
  `claude -p --model <m> --effort <e> --max-budget-usd <b> --output-format json --allowedTools <minimal>`; the JSON result carries the
  usage that `budget-record` stores. This is the main use.
- **Interactive runs:** the router cannot change the model of a person's live session. It still helps in two ways: the agents'
  frontmatter defaults move off `opus` to the router's defaults (after the eval), and a command that delegates through the Agent tool can
  pass the `model` the router names (`node scripts/route/route.js --stage bugFiling`). That second one is prose, so it is checked by the
  same drift lint as the other command prose.
- **By hand:** `scripts/route/route.js --stage S [--signals file]` prints the decision and its reasons, without starting anything.

## Build plan

Four slices, each with its tests, each followed by an independent review as in Phase 3. Slices 1 and 2 have no dependency on Phase 4.

1. **Router core.** `scripts/route/lib/{policy,route}.js`, the `models` block (schema, loader, a test holding the two together), the
   `route.js` CLI. Pure function; the property tests below.
2. **Validators, escalation, recording.** One validator per stage built from checks that already exist (the bug-receipt and test-case
   schemas, `locators.js`, a parse and a `--list`), the escalation rule, the `route` ledger record, `ledger route-stats`, and the
   "Model use" section of `report.js`.
3. **Launcher integration (with Phase 4).** The no-model paths for green and report-only runs; per-stage `claude -p` calls with the router's
   model, effort, caps and a minimal allowlist; `budget-record` from the JSON usage. Verified against a **fake `claude`** on `PATH`.
4. **Agent defaults and the model-in-the-loop eval.** A nightly eval that runs each stage on each tier against the golden scenarios
   (`evals/`) and reports validator pass rate and cost per completed stage. Only after it, change the agents' frontmatter and the shipped
   stage defaults. This slice costs money; it needs the owner's go-ahead and a budget.

## Verification

- **Property tests on the router** (no network, no model): a flag cannot lower a floor; an unknown model or alias is refused;
  escalation is at most one step and only after a failed validator; with no `models` block the decision is today's behaviour; an
  `off` tier means no stage; a stage that cannot fit the remaining budget is refused, not shortened; the same inputs always give the
  same decision and the same reasons; a router error yields the stage default, never a cheaper tier.
- **Launcher tests** against a fake `claude` that records its arguments and returns scripted JSON: a green run starts it zero times; a
  report-only run starts it zero times; a failed validator starts exactly one more call, one tier up; a second failure stops the stage;
  the caps and allowlist in the arguments are the router's.
- **The ledger and report:** a run's `route` and `budget` records render as the "Model use" section, and "not measured" appears where
  nothing was reported.
- **Mutation checks** on the escalation and floor rules, as in Phase 3.
- **Not verifiable here:** that a cheaper tier does the job *well* (that is the eval, slice 4), and real per-call usage (needs a live
  run). Until then the defaults for judgement stages are the conservative ones.

## Limits (documented now, not fixed)

- **`--max-turns`** is accepted by the CLI binary (2.1.294) but is **not listed in `claude --help`**. The Phase 3 design and the v2 plan
  assume it. Treat `--max-budget-usd` (documented) as the hard cap and verify `--max-turns` when the launcher is built.
- **Prices change and aliases move.** `haiku`, `sonnet` and `opus` mean "the latest of that tier"; a new release can change a stage's cost
  and quality overnight. The resolved id in the ledger is how a surprise is traced.
- **Cascades forfeit prompt-cache reuse** across models. The design keeps each stage a short, self-contained call so there is little
  shared prefix to lose, and prefers a lower effort on the same model when a stage continues in one session.
- **Per-token savings are not per-task savings.** The numbers that count are the ones `route-stats` produces from real runs.
- **A router cannot make a bad model good.** It decides where to start and when to step up; whether Haiku can capture evidence reliably
  is what the eval measures.
- **Interactive sessions** keep whatever model the person chose.

## Open questions for review

1. **How conservative at the start?** Proposed: mechanical stages (evidence capture) start on Haiku now, since a validator checks them;
   judgement stages (bug filing, test generation) start on Sonnet only after the first eval, and stay on Opus until then. The alternative
   is Sonnet immediately with the eval as a check after the fact. Which risk do you prefer, a worse bug report or a bigger bill?
2. **Who owns the price table**, and how often is it refreshed? (Proposed: the project config, with `asOf`, reviewed when it is older than 90 days.)
3. **Budget split.** Proposed: each stage gets a configured share of `budget.maxCostUsd`, unused share rolls forward, and a stage that cannot
   fit what is left is refused. Is that the right shape, or one pool first-come first-served?
4. **Should the orchestrator agent keep a floor of Sonnet**, or may it run on Haiku when its only job is reading JSON and calling a script?
   (Proposed: Sonnet floor, because it follows the pinned policy prose and has Bash and Agent.)
5. **Fable and Mythos tiers:** exclude from the defaults (proposed), or allow `escalateTo` them for the rare hard stage?
6. **Is the interactive half worth doing?** (Frontmatter defaults and the Agent-tool `model` pass-through.) It saves tokens for people at a
   keyboard, but it is prose and costs a pinned-file change.
7. **Eval budget for slice 4:** who approves the spend, and how many runs per tier per stage is enough to trust a pass rate?

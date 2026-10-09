#!/usr/bin/env bats
# Failure triage (scripts/triage/): the classifier, fingerprints and locator evidence, plus the check that the
# binding rubric (.claude/memory/failure-triage-rules.md) says what the code does. The unit tests are node:test
# files in tests/triage/; bats gives them a seat in run-tests.sh.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
CHECK="$BATS_TEST_DIRNAME/helpers/triage-rubric-check.js"
ORCH_CHECK="$BATS_TEST_DIRNAME/helpers/orchestrator-drift-check.js"

setup() {
  TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/qa-test.XXXXXX")"
  # a private copy of everything the checker reads, so a test can corrupt the rubric safely
  mkdir -p "$TEST_TMP/.claude/memory" "$TEST_TMP/scripts" "$TEST_TMP/schemas"
  cp "$REPO_ROOT/.claude/memory/failure-triage-rules.md" "$REPO_ROOT/.claude/memory/ai-usage-rules.md" "$TEST_TMP/.claude/memory/"
  cp -R "$REPO_ROOT/.claude/commands" "$REPO_ROOT/.claude/agents" "$REPO_ROOT/.claude/skills" "$TEST_TMP/.claude/"
  cp -R "$REPO_ROOT/scripts/triage" "$REPO_ROOT/scripts/results" "$REPO_ROOT/scripts/tracker" "$REPO_ROOT/scripts/preflight.sh" "$TEST_TMP/scripts/"
  cp "$REPO_ROOT/qa-config.schema.json" "$TEST_TMP/"   # the prose names config keys; the checks verify them against the schema
}
teardown() { rm -rf "$TEST_TMP"; }

node_tests() { cd "$REPO_ROOT" && env -u NODE_TEST_CONTEXT node --test --test-reporter=tap "tests/triage/$1" 2>&1; }

@test "the classifier passes its tests (every rule, precedence, threshold, scope, CLI)" {
  run node_tests classify.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "fingerprints, text signals and locator evidence pass their tests" {
  for f in fingerprint.test.js text.test.js locators.test.js; do
    run node_tests "$f"
    [ "$status" -eq 0 ]
    [[ "$output" =~ "# fail 0" ]]
  done
}

@test "the planner passes its tests on all five tracker mocks (dedupe, regressions, read-only, degraded modes)" {
  run node_tests plan.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "the orchestrator passes its tests (re-run scoping, preflight, missing reports, evidence, outputs)" {
  run node_tests orchestrate.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "every seeded scenario (real bug, stale selector, flaky, environment outage) is run for real and triaged as documented" {
  run node_tests scenarios.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "the triage scripts depend on nothing but Node built-ins" {
  mods=$(grep -rhoE "require\('[^']+'\)" "$REPO_ROOT/scripts/triage" | sed -E "s/require\('([^']+)'\)/\1/" | grep -v '^\.' | sort -u)
  for m in $mods; do
    case "$m" in fs|path|crypto) ;; *) echo "unexpected dependency: $m"; false ;; esac
  done
}

@test "classify.js, run as a real process on real demo output, proposes then acts as re-runs confirm" {
  cd "$REPO_ROOT"
  node scripts/results/normalize.js tests/fixtures/results/node-test.tap --out "$TEST_TMP/run.json" >/dev/null
  run node scripts/triage/classify.js --run "$TEST_TMP/run.json"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq -r '[.data.verdicts[] | "\(.rule):\(.action)"] | join(",")')" = "PRD-3:propose,PRD-3:propose" ]
  run node scripts/triage/classify.js --run "$TEST_TMP/run.json" --rerun "$TEST_TMP/run.json" --rerun "$TEST_TMP/run.json"
  [ "$(echo "$output" | jq -r '[.data.verdicts[] | "\(.rule):\(.action)"] | join(",")')" = "PRD-1:act,PRD-1:act" ]
}

@test "the report schema is valid JSON with an \$id matching its filename" {
  run jq -e '."$id" == "triage-report.schema.json"' "$REPO_ROOT/schemas/triage-report.schema.json"
  [ "$status" -eq 0 ]
}

# ── the rubric says what the code does ─────────────────────────────────────────

@test "the rubric matches the classifier: rules, classes, confidences, order, threshold, flags" {
  run node "$CHECK"
  [ "$status" -eq 0 ]
  [ "$output" = "OK" ]
}

@test "drift: a confidence changed in the rubric only is caught" {
  sed -i.bak 's#| PRD-1 | product-bug | 0.85 |#| PRD-1 | product-bug | 0.95 |#' "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "PRD-1 confidence is 0.95" ]]
}

@test "drift: a class changed in the rubric only is caught" {
  sed -i.bak 's#| TST-2 | test-bug |#| TST-2 | product-bug |#' "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "TST-2 is \"product-bug\" in the prose" ]]
}

@test "drift: a rule dropped from the rubric is caught" {
  grep -v '^| ENV-3 ' "$TEST_TMP/.claude/memory/failure-triage-rules.md" > "$TEST_TMP/x" && mv "$TEST_TMP/x" "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "ENV-3, which the prose does not document" ]]
}

@test "drift: a rule the code does not have is caught" {
  sed -i.bak 's#^| UND-1 |#| XXX-9 | undetermined | 0.1 | made up |\n| UND-1 |#' "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "XXX-9, which the code does not have" ]]
}

@test "drift: rules listed in a different order than the code applies them is caught (order is precedence)" {
  python3 - "$TEST_TMP/.claude/memory/failure-triage-rules.md" <<'PY'
import sys
p = sys.argv[1]
lines = open(p).read().split('\n')
i = next(n for n, l in enumerate(lines) if l.startswith('| ENV-1 '))
lines[i], lines[i + 1] = lines[i + 1], lines[i]
open(p, 'w').write('\n'.join(lines))
PY
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "order is precedence" ]]
}

@test "drift: a different default threshold in the rubric is caught" {
  sed -i.bak 's#default \*\*0.8\*\*#default **0.7**#' "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "states a default threshold of 0.7" ]]
}

@test "drift: a flag the rubric tells the model to pass but the script lacks is caught" {
  sed -i.bak 's#(`--preflight ok|failed`)#(`--preflite ok|failed`)#' "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "--preflite" ]]
}

@test "the memory README lists the triage rules" {
  grep -q "failure-triage-rules.md" "$REPO_ROOT/.claude/memory/README.md"
}

# ── the command and agent prose say what the code does ──────────────────────────

CMD_COPY() { echo "$TEST_TMP/.claude/commands/run-and-triage.md"; }
AGENT_COPY() { echo "$TEST_TMP/.claude/agents/QA-run-orchestrator.md"; }
orch_check() { run env DRIFT_ROOT="$TEST_TMP" node "$ORCH_CHECK"; }

@test "the run-and-triage command and the orchestrator agent match the scripts: flags, steps, re-runs, outputs, marker, tools" {
  run node "$ORCH_CHECK"
  [ "$status" -eq 0 ]
  [ "$output" = "OK" ]
}

@test "orchestrator drift: a flag the script does not define is caught" {
  sed -i.bak 's#--preflight <ok|failed> --run-id#--preflite <ok|failed> --run-id#' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "orchestrate.js has no option --preflite" ]]
}

@test "orchestrator drift: a script that does not exist is caught" {
  sed -i.bak 's#scripts/triage/orchestrate.js --framework#scripts/triage/orchestrte.js --framework#' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "scripts/triage/orchestrte.js does not exist" ]]
}

@test "orchestrator drift: a step the plan can produce but the table does not explain is caught" {
  grep -v '^| `report-flaky` ' "$(CMD_COPY)" > "$TEST_TMP/x" && mv "$TEST_TMP/x" "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "\"report-flaky\" but the step table does not explain it" ]]
}

@test "orchestrator drift: a step the table documents but the plan never produces is caught" {
  sed -i.bak 's#^| `propose` |#| `heal-test` | the test is fixed for you | do it |\n| `propose` |#' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "documents \"heal-test\", which plan.js never produces" ]]
}

@test "orchestrator drift: a wrong re-run range or default is caught" {
  sed -i.bak 's#(`--reruns`, 0–5)#(`--reruns`, 0–9)#' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "states re-runs 0–9 but the code allows 0–5" ]]
  cp "$REPO_ROOT/.claude/commands/run-and-triage.md" "$(CMD_COPY)"
  sed -i.bak 's#Re-runs default to 2#Re-runs default to 4#' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "says re-runs default to 4 but the code defaults to 2" ]]
}

@test "orchestrator drift: an output file the code does not write is caught" {
  sed -i.bak 's#flaky.json#flakey.json#g' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "flakey.json" ]] || [[ "$output" =~ "no longer mentions flaky.json" ]]
}

@test "orchestrator drift: dropping the fingerprint marker from the command, or from file-bug, is caught" {
  sed -i.bak 's#qa-harness-fingerprint: <token>#fingerprint <token>#g' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "does not tell the model to put \"qa-harness-fingerprint: <token>\"" ]]
  cp "$REPO_ROOT/.claude/commands/run-and-triage.md" "$(CMD_COPY)"
  sed -i.bak 's#qa-harness-fingerprint: <token>#fingerprint <token>#g' "$TEST_TMP/.claude/commands/file-bug.md"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "file-bug.md does not know about the fingerprint marker" ]]
}

@test "orchestrator drift: no longer delegating filing to Bug-reporter is caught" {
  sed -i.bak 's#\*\*Bug-reporter\*\* agent#a helper#g' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no longer delegates filing to the Bug-reporter agent" ]]
}

@test "orchestrator drift: giving the agent an Edit tool (it must not be able to change files) is caught" {
  sed -i.bak 's#^tools: Read, Write, Bash#tools: Read, Write, Edit, Bash#' "$(AGENT_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "has the Edit tool" ]]
}

@test "orchestrator drift: an agent that cannot delegate to Bug-reporter is caught" {
  sed -i.bak 's#, Agent, AskUserQuestion#, AskUserQuestion#' "$(AGENT_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "needs the Agent tool" ]]
}

@test "orchestrator drift: an agent that no longer points at the command is caught" {
  sed -i.bak 's#run-and-triage.md#something-else.md#g' "$(AGENT_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "does not point at .claude/commands/run-and-triage.md" ]]
}

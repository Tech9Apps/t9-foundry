#!/usr/bin/env bats
# Failure triage (scripts/triage/): the classifier, fingerprints and locator evidence, plus the check that the
# binding rubric (.claude/memory/failure-triage-rules.md) says what the code does. The unit tests are node:test
# files in tests/triage/; bats gives them a seat in run-tests.sh.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
CHECK="$BATS_TEST_DIRNAME/helpers/triage-rubric-check.js"

setup() {
  TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/qa-test.XXXXXX")"
  # a private copy of everything the checker reads, so a test can corrupt the rubric safely
  mkdir -p "$TEST_TMP/.claude/memory" "$TEST_TMP/scripts" "$TEST_TMP/schemas"
  cp "$REPO_ROOT/.claude/memory/failure-triage-rules.md" "$TEST_TMP/.claude/memory/"
  cp -R "$REPO_ROOT/scripts/triage" "$REPO_ROOT/scripts/results" "$TEST_TMP/scripts/"
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

#!/usr/bin/env bats
# Scenario evals (evals/): the demo's three tickets, with golden expectations, run through the real
# fetch / post-tests / create-bug / comment CLIs against every in-process tracker — including the
# failure drills (transient failure, lost response, revoked credentials, wrong parent).

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"

setup() {
  TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/qa-test.XXXXXX")"
}
teardown() {
  rm -rf "$TEST_TMP"
}

@test "every scenario passes on every tracker" {
  run node "$REPO_ROOT/evals/run.js" --json
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq -r '.ok')" = "true" ]
  [ "$(echo "$output" | jq -r '.failed')" = "0" ]
  [ "$(echo "$output" | jq -r '[.results[].tracker] | unique | length')" = "3" ]
  [ "$(echo "$output" | jq -r '[.results[].scenario] | unique | length')" -ge 3 ]
  [ "$(echo "$output" | jq -r '.total')" -ge 87 ]
}

@test "the human-readable report shows a pass/fail cell per tracker" {
  run node "$REPO_ROOT/evals/run.js"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "github ✓  clickup ✓  azure ✓" ]]
  [[ "$output" =~ "87/87 checks passed" ]]
}

@test "--tracker and --scenario narrow the run" {
  run node "$REPO_ROOT/evals/run.js" --json --tracker clickup --scenario "DEMO-102"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq -r '[.results[].tracker] | unique | join(",")')" = "clickup" ]
  [ "$(echo "$output" | jq -r '[.results[].scenario] | unique | join(",")')" = "DEMO-102 order totals" ]
}

@test "a WRONG golden fails the eval (the evals can actually fail)" {
  mkdir -p "$TEST_TMP/scenarios"
  jq '.golden.cases = 99' "$REPO_ROOT/evals/scenarios/demo-101-discount-codes.json" > "$TEST_TMP/scenarios/wrong.json"
  run env EVALS_SCENARIOS_DIR="$TEST_TMP/scenarios" node "$REPO_ROOT/evals/run.js" --tracker github
  [ "$status" -eq 1 ]
  [[ "$output" =~ "✗" ]]
  [[ "$output" =~ "expected exactly 99 test cases" ]]
}

@test "every scenario points at files that exist, and its golden counts match the sample cases (grep, not the parser)" {
  for f in "$REPO_ROOT"/evals/scenarios/*.json; do
    ticket=$(jq -r '.ticket' "$f"); cases=$(jq -r '.cases' "$f")
    [ -f "$REPO_ROOT/$ticket" ]
    [ -f "$REPO_ROOT/$cases" ]
    for r in $(jq -r '.golden.bugs[].report' "$f"); do [ -f "$REPO_ROOT/$r" ]; done
    [ "$(grep -c '^### TC-' "$REPO_ROOT/$cases")" = "$(jq -r '.golden.cases' "$f")" ]
    for p in High Medium Low; do
      [ "$(grep -c "Priority:\*\* $p" "$REPO_ROOT/$cases")" = "$(jq -r --arg p "$p" '.golden.priorities[$p]' "$f")" ]
    done
  done
}

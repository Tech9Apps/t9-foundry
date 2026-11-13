#!/usr/bin/env bats
# The run ledger (scripts/ledger/): state, idempotency keys and locks as plain files. The design is docs/phase-3-design.md. The unit tests are
# node:test files in tests/ledger/; bats gives them a seat in run-tests.sh. They include real child processes (a kill in the middle of a claim,
# eight callers racing for one key or one stale lock), so they are the part of the suite that would show a lost or doubled claim.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"

node_tests() { cd "$REPO_ROOT" && env -u NODE_TEST_CONTEXT node --test --test-reporter=tap "tests/ledger/$1" 2>&1; }

teardown() {
  # a failing node suite run through `run` shows only "status -eq 0 failed": print what failed (CI is the only place some of these ever fail)
  if [ -z "${BATS_TEST_COMPLETED:-}" ] && [ -n "${output:-}" ]; then printf '%s\n' "$output" | grep -A14 'not ok' | head -80 >&3; fi
}

@test "the ledger passes its tests (records, damaged files, names, keys, locks, pruning, schema)" {
  run node_tests ledger.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "the ledger CLI and its qa-config.json block pass their tests" {
  run node_tests cli.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "run-id helpers shared with the triage planner pass their tests" {
  run node_tests ids.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test ".qa-ledger/ is gitignored, so run detail is never committed by accident" {
  cd "$REPO_ROOT"
  run git check-ignore -q .qa-ledger/runs/x.jsonl
  [ "$status" -eq 0 ]
}

@test "the ledger layout in the design doc is the one the code uses" {
  cd "$REPO_ROOT"
  for part in "runs/<runId>.jsonl" "keys/<hash>.json" "locks/<scope>.lock" "audit.jsonl" "VERSION"; do
    grep -q "$part" docs/phase-3-design.md || { echo "docs/phase-3-design.md no longer mentions $part"; false; }
  done
  for part in "runs" "keys" "locks" "audit.jsonl" "VERSION"; do
    grep -q "'$part'\|\`$part\`\|p('$part'" scripts/ledger/lib/ledger.js || { echo "ledger.js does not use $part"; false; }
  done
}

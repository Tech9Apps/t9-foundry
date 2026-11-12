#!/usr/bin/env bats
# The code every script shares (scripts/lib/): command-line parsing, JSON reading and writing, and the error shapes the scripts report.
# The tests are node:test files in tests/lib/; bats gives them a seat in run-tests.sh.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"

node_tests() { # <file> -> runs it, echoes the TAP summary lines
  cd "$REPO_ROOT" && env -u NODE_TEST_CONTEXT node --test --test-reporter=tap "tests/lib/$1" 2>&1
}

@test "the shared CLI module passes its tests (flag tables, usage errors, JSON read and write)" {
  run node_tests cli.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "escaping text for a pattern (used for idempotency keys and test ids) matches exactly that text" {
  run node_tests regex.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "every script that takes options exports the FLAGS table the checks read, and nothing parses argv by hand any more" {
  cd "$REPO_ROOT"
  for s in tracker/cli tracker/post-tests tracker/smoke results/run results/normalize triage/classify triage/plan triage/orchestrate triage/heal triage/locators; do
    run node -e "const f = require('./scripts/$s.js').FLAGS; if (!f || !Object.keys(f).length) process.exit(1)"
    [ "$status" -eq 0 ]
  done
  run grep -rnE "flag === '--|needs a value" scripts --include='*.js'
  [[ "$output" =~ "scripts/lib/cli.js" ]]   # the one place that says "needs a value"
  [ "$(echo "$output" | grep -vc 'scripts/lib/cli.js')" -eq 0 ]
}

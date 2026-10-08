#!/usr/bin/env bats
# Tracker adapters (scripts/tracker/): the contract every adapter must meet, per-adapter specifics,
# and the CLI — all against in-process mocks (tests/mocks/tracker-mock/), so no network, no ports.
# The tests themselves are node:test files in tests/tracker/; bats gives them a seat in run-tests.sh.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"

node_tests() { # <file> -> runs it, echoes the TAP summary lines
  cd "$REPO_ROOT" && node --test --test-reporter=tap "tests/tracker/$1" 2>&1
}

@test "github adapter passes the tracker contract suite and its own tests" {
  run node_tests github.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "clickup adapter passes the tracker contract suite and its own tests" {
  run node_tests clickup.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "azure adapter passes the tracker contract suite and its own tests" {
  run node_tests azure.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "the tracker CLI passes its tests" {
  run node_tests cli.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "the contract suite is actually exercised by every adapter (no adapter silently skips it)" {
  for a in github clickup azure; do
    grep -q "runContractSuite('$a'" "$REPO_ROOT/tests/tracker/$a.test.js"
  done
  # every adapter the registry knows about has a test file
  for a in $(sed -n "/^const ADAPTERS = {/,/^};/p" "$REPO_ROOT/scripts/tracker/adapters/index.js" | grep -oE "^  [a-z]+:" | tr -d ' :'); do
    [ -f "$REPO_ROOT/tests/tracker/$a.test.js" ]
  done
}

@test "the adapters depend on nothing but Node built-ins (no npm install needed to run them)" {
  mods=$(grep -rhoE "require\('[^']+'\)" "$REPO_ROOT/scripts/tracker" | sed -E "s/require\('([^']+)'\)/\1/" | grep -v '^\.' | sort -u)
  for m in $mods; do
    case "$m" in fs|path) ;; *) echo "unexpected dependency: $m"; false ;; esac
  done
}

@test "the mocks never open a socket" {
  run grep -rnE "createServer|\.listen\(" "$REPO_ROOT/tests/mocks/tracker-mock"
  [ "$status" -eq 1 ]
}

@test "every schema in schemas/ is valid JSON with an \$id matching its filename" {
  for f in "$REPO_ROOT"/schemas/*.schema.json; do
    run jq -e --arg id "$(basename "$f")" '."$id" == $id' "$f"
    [ "$status" -eq 0 ]
  done
}

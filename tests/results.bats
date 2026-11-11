#!/usr/bin/env bats
# Structured test results (scripts/results/): parsers for JUnit / TAP / Playwright JSON / Jest JSON, the
# per-framework run recipes, and the runner that cross-checks a report against the runner's exit code.
# The tests are node:test files in tests/results/; bats gives them a seat in run-tests.sh.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"

node_tests() { # <file> -> runs it, echoes the TAP summary lines
  cd "$REPO_ROOT" && env -u NODE_TEST_CONTEXT node --test --test-reporter=tap "tests/results/$1" 2>&1
}

@test "the normalizer parses every supported format (real node:test output + hand-written fixtures)" {
  run node_tests normalize.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "the runner and the framework recipes pass their tests (including a real node --test run)" {
  run node_tests run.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "the demo app's real suite normalizes to 22 tests with the two planted failures" {
  cd "$REPO_ROOT"
  # the runner's own output goes to stderr (stdout is one JSON document), and `run` would merge the two
  run bash -c 'node scripts/results/run.js --framework node --cwd demo/app --out "$1" 2>/dev/null' _ "${TMPDIR:-/tmp}/qa-results-bats.$$"
  [ "$status" -eq 1 ]
  [ "$(echo "$output" | jq '.data.totals.total')" = "22" ]
  [ "$(echo "$output" | jq -c '[.data.tests[] | select(.status=="failed") | "\(.ticket)/\(.caseId)"]')" = '["DEMO-101/TC-005","DEMO-102/TC-006"]' ]
  rm -rf "${TMPDIR:-/tmp}/qa-results-bats.$$"
}

@test "the results scripts depend on nothing but Node built-ins" {
  mods=$(grep -rhoE "require\('[^']+'\)" "$REPO_ROOT/scripts/results" | sed -E "s/require\('([^']+)'\)/\1/" | grep -v '^\.' | sort -u)
  for m in $mods; do
    case "$m" in fs|path|child_process|events) ;; *) echo "unexpected dependency: $m"; false ;; esac
  done
}

@test "every framework the harness lists has a recipe or is deliberately excluded" {
  # qa-config.schema.json lists these; each must be in SUPPORTED, or named here as having no recipe
  for fw in $(jq -r '.properties.testFramework.properties.type.enum[]' "$REPO_ROOT/qa-config.schema.json"); do
    case "$fw" in
      selenium|other) continue ;;   # no framework-neutral way to ask for a structured report; use normalize.js on whatever it writes
    esac
    grep -q "'$fw'" "$REPO_ROOT/scripts/results/frameworks.js"
  done
}

@test "fixtures are not named qa-config.json (it is git-ignored) and hand-written ones say so" {
  [ -z "$(find "$REPO_ROOT/tests/fixtures/results" -name qa-config.json)" ]
  grep -q "Hand-written from memory" "$REPO_ROOT/tests/fixtures/results/README.md"
}

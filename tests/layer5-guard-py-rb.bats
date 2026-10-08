#!/usr/bin/env bats
# Layer 5 runtime guard in the Python (pytest, selenium) and Ruby (rspec) templates.
# Same contract as the TypeScript guards: configured prodUrlPatterns always block;
# the suspicious-URL heuristic warns (default) or blocks (enforce); allowedUrlPatterns
# exempts the heuristic only; blockOnSuspiciousUrls=false disables it.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
FIXTURES="$BATS_TEST_DIRNAME/fixtures"

setup() {
  TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/qa-test.XXXXXX")"
  export PYTHONDONTWRITEBYTECODE=1
  unset QA_AUTONOMOUS
}

teardown() {
  rm -rf "$TEST_TMP"
}

# Put a fixture where QA_HARNESS_DIR will find it (qa-config.json is gitignored,
# so it is created at runtime rather than committed).
use_config() {
  mkdir -p "$TEST_TMP/harness"
  cp "$FIXTURES/$1" "$TEST_TMP/harness/qa-config.json"
  export QA_HARNESS_DIR="$TEST_TMP/harness"
}

py_guard() { # <framework> <url>
  cd "$REPO_ROOT/templates/e2e/$1" && python3 -B -c \
    'import sys; from support.prod_guard import validate_not_production as v; v(sys.argv[1])' "$2" 2>&1
}

rb_guard() { # <url>
  cd "$REPO_ROOT/templates/e2e/rspec" && ruby -e \
    'require "./spec/support/prod_guard"; ProdGuard.validate_not_production(ARGV[0])' "$1" 2>&1
}

# ── Python (pytest + selenium) ───────────────────────────────────────────────

@test "python: a configured production pattern blocks" {
  command -v python3 >/dev/null || skip "python3 not installed"
  use_config prod-url-config.json
  for fw in pytest selenium; do
    run py_guard "$fw" "https://myapp.example.com/x"
    [ "$status" -ne 0 ]
    [[ "$output" =~ "matches a production pattern" ]]
  done
}

@test "python: warn mode (default) only warns on a suspicious URL" {
  command -v python3 >/dev/null || skip "python3 not installed"
  use_config prod-url-config.json
  for fw in pytest selenium; do
    run py_guard "$fw" "https://otherapp.io/"
    [ "$status" -eq 0 ]
    [[ "$output" =~ "WARNING" ]]
  done
}

@test "python: QA_AUTONOMOUS=1 blocks a suspicious URL" {
  command -v python3 >/dev/null || skip "python3 not installed"
  use_config prod-url-config.json
  export QA_AUTONOMOUS=1
  for fw in pytest selenium; do
    run py_guard "$fw" "https://otherapp.io/"
    [ "$status" -ne 0 ]
    [[ "$output" =~ "enforce" ]]
  done
}

@test "python: productionProtection.mode=enforce blocks; staging and allowedUrlPatterns pass" {
  command -v python3 >/dev/null || skip "python3 not installed"
  use_config enforce-config.json
  for fw in pytest selenium; do
    run py_guard "$fw" "https://otherapp.io/"
    [ "$status" -ne 0 ]
    run py_guard "$fw" "https://staging.myapp.example.com"
    [ "$status" -eq 0 ]
    run py_guard "$fw" "https://partner.io/guide/setup"
    [ "$status" -eq 0 ]
  done
}

@test "python: blockOnSuspiciousUrls=false disables the heuristic even in enforce" {
  command -v python3 >/dev/null || skip "python3 not installed"
  use_config azure-config.json
  export QA_AUTONOMOUS=1
  run py_guard pytest "https://otherapp.io/"
  [ "$status" -eq 0 ]
}

# ── Ruby (rspec) ─────────────────────────────────────────────────────────────

@test "ruby: a configured production pattern blocks" {
  command -v ruby >/dev/null || skip "ruby not installed"
  use_config prod-url-config.json
  run rb_guard "https://myapp.example.com/x"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "matches a production pattern" ]]
}

@test "ruby: warn mode (default) only warns on a suspicious URL" {
  command -v ruby >/dev/null || skip "ruby not installed"
  use_config prod-url-config.json
  run rb_guard "https://otherapp.io/"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "WARNING" ]]
}

@test "ruby: QA_AUTONOMOUS=1 blocks a suspicious URL" {
  command -v ruby >/dev/null || skip "ruby not installed"
  use_config prod-url-config.json
  export QA_AUTONOMOUS=1
  run rb_guard "https://otherapp.io/"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "enforce" ]]
}

@test "ruby: productionProtection.mode=enforce blocks; staging and allowedUrlPatterns pass" {
  command -v ruby >/dev/null || skip "ruby not installed"
  use_config enforce-config.json
  run rb_guard "https://otherapp.io/"
  [ "$status" -ne 0 ]
  run rb_guard "https://staging.myapp.example.com"
  [ "$status" -eq 0 ]
  run rb_guard "https://partner.io/guide/setup"
  [ "$status" -eq 0 ]
}

@test "ruby: blockOnSuspiciousUrls=false disables the heuristic even in enforce" {
  command -v ruby >/dev/null || skip "ruby not installed"
  use_config azure-config.json
  export QA_AUTONOMOUS=1
  run rb_guard "https://otherapp.io/"
  [ "$status" -eq 0 ]
}

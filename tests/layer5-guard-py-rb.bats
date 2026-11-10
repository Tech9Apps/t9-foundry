#!/usr/bin/env bats
# Layer 5 runtime guard in the Python (pytest, selenium) and Ruby (rspec) templates.
# Same contract as the TypeScript guards: configured prodUrlPatterns always block;
# the suspicious-URL heuristic warns (default) or blocks (enforce); allowedUrlPatterns
# exempts the heuristic only; blockOnSuspiciousUrls=false disables it.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
FIXTURES="$BATS_TEST_DIRNAME/fixtures"
load helpers/find-python

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
  cd "$REPO_ROOT/templates/e2e/$1" && "$PY" -B -c \
    'import sys; from support.prod_guard import validate_not_production as v; v(sys.argv[1])' "$2" 2>&1
}

rb_guard() { # <url>
  cd "$REPO_ROOT/templates/e2e/rspec" && ruby -e \
    'require "./spec/support/prod_guard"; ProdGuard.validate_not_production(ARGV[0])' "$1" 2>&1
}

# ── Python (pytest + selenium) ───────────────────────────────────────────────

@test "python: a configured production pattern blocks" {
  find_python || skip "no working python3 (a macOS python3 shim fails until the Xcode licence is accepted)"
  use_config prod-url-config.json
  for fw in pytest selenium; do
    run py_guard "$fw" "https://myapp.example.com/x"
    [ "$status" -ne 0 ]
    [[ "$output" =~ "matches a production pattern" ]]
  done
}

@test "python: warn mode (default) only warns on a suspicious URL" {
  find_python || skip "no working python3 (a macOS python3 shim fails until the Xcode licence is accepted)"
  use_config prod-url-config.json
  for fw in pytest selenium; do
    run py_guard "$fw" "https://otherapp.io/"
    [ "$status" -eq 0 ]
    [[ "$output" =~ "WARNING" ]]
  done
}

@test "python: QA_AUTONOMOUS=1 blocks a suspicious URL" {
  find_python || skip "no working python3 (a macOS python3 shim fails until the Xcode licence is accepted)"
  use_config prod-url-config.json
  export QA_AUTONOMOUS=1
  for fw in pytest selenium; do
    run py_guard "$fw" "https://otherapp.io/"
    [ "$status" -ne 0 ]
    [[ "$output" =~ "enforce" ]]
  done
}

@test "python: productionProtection.mode=enforce blocks; staging and allowedUrlPatterns pass" {
  find_python || skip "no working python3 (a macOS python3 shim fails until the Xcode licence is accepted)"
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
  find_python || skip "no working python3 (a macOS python3 shim fails until the Xcode licence is accepted)"
  use_config azure-config.json
  export QA_AUTONOMOUS=1
  run py_guard pytest "https://otherapp.io/"
  [ "$status" -eq 0 ]
}

# ── Ruby (rspec) ─────────────────────────────────────────────────────────────

@test "ruby: a configured production pattern blocks" {
  ruby -e "exit 0" >/dev/null 2>&1 || skip "ruby does not run here"
  use_config prod-url-config.json
  run rb_guard "https://myapp.example.com/x"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "matches a production pattern" ]]
}

@test "ruby: warn mode (default) only warns on a suspicious URL" {
  ruby -e "exit 0" >/dev/null 2>&1 || skip "ruby does not run here"
  use_config prod-url-config.json
  run rb_guard "https://otherapp.io/"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "WARNING" ]]
}

@test "ruby: QA_AUTONOMOUS=1 blocks a suspicious URL" {
  ruby -e "exit 0" >/dev/null 2>&1 || skip "ruby does not run here"
  use_config prod-url-config.json
  export QA_AUTONOMOUS=1
  run rb_guard "https://otherapp.io/"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "enforce" ]]
}

@test "ruby: productionProtection.mode=enforce blocks; staging and allowedUrlPatterns pass" {
  ruby -e "exit 0" >/dev/null 2>&1 || skip "ruby does not run here"
  use_config enforce-config.json
  run rb_guard "https://otherapp.io/"
  [ "$status" -ne 0 ]
  run rb_guard "https://staging.myapp.example.com"
  [ "$status" -eq 0 ]
  run rb_guard "https://partner.io/guide/setup"
  [ "$status" -eq 0 ]
}

@test "ruby: blockOnSuspiciousUrls=false disables the heuristic even in enforce" {
  ruby -e "exit 0" >/dev/null 2>&1 || skip "ruby does not run here"
  use_config azure-config.json
  export QA_AUTONOMOUS=1
  run rb_guard "https://otherapp.io/"
  [ "$status" -eq 0 ]
}

# ── a config the guard cannot read must not be mistaken for "no config" ──────────────────────────

malformed_config() {
  mkdir -p "$TEST_TMP/harness"
  printf '{ not json' > "$TEST_TMP/harness/qa-config.json"
  export QA_HARNESS_DIR="$TEST_TMP/harness"
}

@test "python: a malformed qa-config.json blocks an unattended run, and only warns an attended one" {
  find_python || skip "no working python3 (a macOS python3 shim fails until the Xcode licence is accepted)"
  malformed_config
  for fw in pytest selenium; do
    QA_AUTONOMOUS=1 run py_guard "$fw" "https://staging.acme.com"
    [ "$status" -ne 0 ]
    [[ "$output" =~ "could not be read" ]]
    run py_guard "$fw" "https://staging.acme.com"
    [ "$status" -eq 0 ]
    [[ "$output" =~ "NOT being applied" ]]
  done
}

@test "ruby: a malformed qa-config.json blocks an unattended run, and only warns an attended one" {
  ruby -e "exit 0" >/dev/null 2>&1 || skip "ruby does not run here"
  malformed_config
  QA_AUTONOMOUS=1 run rb_guard "https://staging.acme.com"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "could not be read" ]]
  run rb_guard "https://staging.acme.com"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "NOT being applied" ]]
}

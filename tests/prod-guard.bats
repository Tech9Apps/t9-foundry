#!/usr/bin/env bats
# Tests for hooks/prod-guard.sh — Layer 3 production safety guard.
# The hook reads a JSON object from stdin with .tool_input.command and
# exits 2 (blocking) when the command targets a production environment.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
GUARD="$REPO_ROOT/hooks/prod-guard.sh"
FIXTURES="$BATS_TEST_DIRNAME/fixtures"

setup() {
  TEST_TMP="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TMP"
}

# Write a guard input JSON file and run the hook from TEST_TMP.
# Usage: guard_input "the shell command string" [fixture-config-filename]
guard_input() {
  local cmd="$1"
  local config="${2:-}"
  jq -n --arg cmd "$cmd" '{"tool_input":{"command":$cmd}}' > "$TEST_TMP/input.json"
  if [ -n "$config" ]; then
    cp "$FIXTURES/$config" "$TEST_TMP/qa-config.json"
  fi
}

# ── Passthrough cases ─────────────────────────────────────────────────────────

@test "passes a command with no URLs or env vars" {
  guard_input "npx playwright test --list"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
}

@test "passes a command referencing the staging URL" {
  guard_input "curl https://staging.myapp.example.com/health" "prod-url-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
}

@test "passes APP_ENV=staging" {
  guard_input "APP_ENV=staging pytest tests/"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
}

@test "passes NODE_ENV=development" {
  guard_input "NODE_ENV=development npm test"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
}

@test "exits 0 when tool_input.command is absent" {
  echo '{}' > "$TEST_TMP/input.json"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
}

# ── Production env var blocking ───────────────────────────────────────────────

@test "blocks NODE_ENV=production" {
  guard_input "NODE_ENV=production npx playwright test"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "blocks RAILS_ENV=production" {
  guard_input "RAILS_ENV=production bundle exec rspec"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "blocks APP_ENV=prod" {
  guard_input "APP_ENV=prod pytest tests/"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "blocks APP_ENV=production" {
  guard_input "APP_ENV=production pytest tests/"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "blocks DJANGO_ENV=production" {
  guard_input "DJANGO_ENV=production python manage.py test"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "blocks --env=production flag" {
  guard_input "npx playwright test --env=production"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "blocks --environment=production flag" {
  guard_input "npx cypress run --environment=production"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

# ── Configured prod URL pattern blocking ─────────────────────────────────────

@test "blocks a URL matching a configured prod pattern" {
  guard_input "curl https://myapp.example.com/api/health" "prod-url-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "blocks the app subdomain matching a configured prod pattern" {
  guard_input "curl https://app.myapp.example.com/api/users" "prod-url-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "does not block a staging URL when prod patterns are configured" {
  guard_input "curl https://staging.myapp.example.com/api/health" "prod-url-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
}

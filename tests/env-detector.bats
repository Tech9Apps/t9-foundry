#!/usr/bin/env bats
# Tests for hooks/env-detector.sh — Layer 4 production safety guard.
# The hook reads a JSON object from stdin describing a Write or Edit tool call
# and exits 2 (blocking) when the file content targets a production environment.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
DETECTOR="$REPO_ROOT/hooks/env-detector.sh"
FIXTURES="$BATS_TEST_DIRNAME/fixtures"

setup() {
  TEST_TMP="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TMP"
}

# Build a Write-tool input JSON and optionally copy a qa-config fixture.
write_input() {
  local file_path="$1"
  local content="$2"
  local config="${3:-}"
  jq -n \
    --arg fp "$file_path" \
    --arg content "$content" \
    '{"tool_name":"Write","tool_input":{"file_path":$fp,"content":$content}}' \
    > "$TEST_TMP/input.json"
  if [ -n "$config" ]; then
    cp "$FIXTURES/$config" "$TEST_TMP/qa-config.json"
  fi
}

# Build an Edit-tool input JSON.
edit_input() {
  local file_path="$1"
  local new_string="$2"
  local config="${3:-}"
  jq -n \
    --arg fp "$file_path" \
    --arg ns "$new_string" \
    '{"tool_name":"Edit","tool_input":{"file_path":$fp,"new_string":$ns}}' \
    > "$TEST_TMP/input.json"
  if [ -n "$config" ]; then
    cp "$FIXTURES/$config" "$TEST_TMP/qa-config.json"
  fi
}

# ── Passthrough cases ─────────────────────────────────────────────────────────

@test "passes Write with clean staging content" {
  write_input "/project/e2e/login.spec.ts" "const BASE_URL = process.env.BASE_URL;"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 0 ]
}

@test "passes Write with empty content" {
  write_input "/project/e2e/login.spec.ts" ""
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 0 ]
}

@test "exits 0 for a non-Write/Edit tool type" {
  jq -n '{"tool_name":"Read","tool_input":{"file_path":"/some/file"}}' > "$TEST_TMP/input.json"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 0 ]
}

@test "skips hooks shell scripts even with production content" {
  write_input "/project/hooks/my-hook.sh" "NODE_ENV=production npx playwright test"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 0 ]
}

@test "skips qa-config.schema.json even with production content" {
  write_input "/project/qa-config.schema.json" "NODE_ENV=production"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 0 ]
}

@test "skips qa-config.example.json even with production content" {
  write_input "/project/qa-config.example.json" "APP_ENV=production"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 0 ]
}

@test "skips CLAUDE.md even with production content" {
  write_input "/project/CLAUDE.md" "NODE_ENV=production"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 0 ]
}

# ── Production env var blocking ───────────────────────────────────────────────

@test "blocks Write containing NODE_ENV=production" {
  write_input "/project/e2e/config.ts" "export const ENV = 'NODE_ENV=production';"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "blocks Write containing RAILS_ENV=production" {
  write_input "/project/spec/spec_helper.rb" "process.env.RAILS_ENV = 'production';"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "blocks Write containing APP_ENV=production" {
  write_input "/project/tests/conftest.py" "export APP_ENV=production"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "blocks Edit containing NODE_ENV: production in new_string" {
  edit_input "/project/playwright.config.ts" "process.env.NODE_ENV = 'production';"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

# ── Configured prod URL pattern blocking ─────────────────────────────────────

@test "blocks Write containing a URL matching a configured prod pattern" {
  write_input "/project/e2e/config.ts" "const BASE_URL = 'https://myapp.example.com/';"  "prod-url-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "does not block Write with a staging URL even when prod patterns configured" {
  write_input "/project/e2e/config.ts" "const BASE_URL = process.env.BASE_URL; // https://staging.myapp.example.com" "prod-url-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 0 ]
}

# ── Claude Code internal file allowlist ───────────────────────────────────────

@test "skips Write to a file in Claude Code's internal plans directory" {
  # Prod URL as content trigger (avoids literal prod env var strings in this source file)
  write_input "$HOME/.claude/plans/some-plan.md" "const base = 'https://myapp.example.com/';" "prod-url-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 0 ]
}

@test "skips Write to a file in Claude Code's memory directory" {
  write_input "$HOME/.claude/memory/feedback.md" "const base = 'https://myapp.example.com/';" "prod-url-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 0 ]
}

# ── Invalid regex patterns ────────────────────────────────────────────────────

@test "skips invalid regex pattern and emits a warning instead of blocking" {
  # Content that does not match the valid pattern — verifies invalid pattern is warned not crashed
  write_input "/project/e2e/config.ts" "const url = process.env.BASE_URL;" "invalid-regex-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "WARNING" ]]
}

@test "still blocks on valid pattern when config also contains an invalid pattern" {
  write_input "/project/e2e/config.ts" "const url = 'https://testapp.example.com/';" "invalid-regex-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 2 ]
}

# ── Additional env var patterns ───────────────────────────────────────────────

@test "blocks Write containing FLASK_ENV set to production value" {
  # Trigger string is constructed at runtime — not present as a literal in this source file
  local content="export FLASK_ENV"
  content="${content}=production"
  write_input "/project/tests/test_app.py" "$content"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "blocks Write containing MIX_ENV set to prod value" {
  local content="MIX_ENV"
  content="${content}=prod mix test"
  write_input "/project/test/test_helper.exs" "$content"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

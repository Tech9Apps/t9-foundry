#!/usr/bin/env bats
# Tests for hooks/env-detector.sh — Layer 4 production safety guard.
# The hook reads a JSON object from stdin describing a Write or Edit tool call
# and exits 2 (blocking) when the file content targets a production environment.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
DETECTOR="$REPO_ROOT/hooks/env-detector.sh"
FIXTURES="$BATS_TEST_DIRNAME/fixtures"

setup() {
  unset QA_AUTONOMOUS QA_HARNESS_DIR CLAUDE_PROJECT_DIR # hermetic: an exported autonomous/harness env must not change what these tests mean
  TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/qa-test.XXXXXX")"
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

# ── Heuristic fallback stays on once prod patterns are configured ────────────

@test "still warns on a hardcoded URL outside the configured patterns, even when patterns exist" {
  write_input "/project/e2e/config.ts" "const other = 'https://otherapp.io/page';" "prod-url-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "WARNING" ]]
}

# ── Enforce mode (unattended runs fail closed) ───────────────────────────────

@test "enforce mode via config: blocks a Write of code containing a suspicious hardcoded URL" {
  write_input "/project/e2e/config.ts" "const other = 'https://otherapp.io/page';" "enforce-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "enforce mode via QA_AUTONOMOUS=1: blocks even when the config says warn" {
  write_input "/project/e2e/config.ts" "const other = 'https://otherapp.io/page';" "prod-url-config.json"
  run env QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "enforce mode: documentation files only warn (they legitimately link out)" {
  write_input "/project/test-cases/notes.md" "See https://otherapp.io/page for details." "enforce-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "WARNING" ]]
}

@test "enforce mode: tracker/code-host URLs and allowedUrlPatterns are exempt" {
  write_input "/project/e2e/links.ts" "// https://github.com/Tech9Apps/t9-foundry/issues/1 and https://partner.io/guide/setup" "enforce-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 0 ]
}

# ── cwd-independent config resolution ─────────────────────────────────────────

@test "resolves qa-config.json via CLAUDE_PROJECT_DIR when the tool's cwd has no config" {
  # qa-config.json is gitignored repo-wide, so build the CLAUDE_PROJECT_DIR
  # fixture at runtime (like write_input does for cwd) instead of committing
  # a file with that literal name under tests/fixtures/.
  local project_dir="$(mktemp -d "${TMPDIR:-/tmp}/qa-test.XXXXXX")"
  cp "$FIXTURES/prod-url-config.json" "$project_dir/qa-config.json"
  write_input "/project/e2e/config.ts" "const base = 'https://myapp.example.com/';"
  run env CLAUDE_PROJECT_DIR="$project_dir" bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  rm -rf "$project_dir"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
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

# ── Review findings: the file-content scan shares the host-based decision ─────────────────────────────────────────────────

enforce_config() {
  jq -n --argjson p "${1:-[]}" '{productionProtection:{mode:"enforce",prodUrlPatterns:$p}}' > "$TEST_TMP/qa-config.json"
}
run_detector() { run env -u QA_AUTONOMOUS bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"; }

@test "enforce: dev/test/qa/staging in a hardcoded URL's path or query no longer excuses it (the old whole-URL substring exemption)" {
  enforce_config
  for url in 'https://prod.mybank.com/api/latest' 'https://shop.acme.com/login?x=test' 'https://shop.acme.com/dev/x' 'https://acme.dev/x' 'https://www.acme.com/x'; do
    write_input "tests/api.spec.ts" "const base = \"$url\";"
    run_detector
    echo "$url -> $status: $output"
    [ "$status" -eq 2 ]
  done
}

@test "enforce: hardcoded URLs that are recognizably a test environment still pass" {
  enforce_config
  write_input "tests/api.spec.ts" 'const a = "https://staging.acme.com/x"; const b = "http://localhost:3000"; const c = "http://127.0.0.1:8080"; const d = "https://acme.test";'
  run_detector
  [ "$status" -eq 0 ]
}

@test "enforce: a hardcoded URL matching a configured pattern in ANY spelling blocks (case, userinfo, port, no path, trailing dot)" {
  enforce_config '["://myapp\\.example\\.com/"]'
  for url in 'https://MyApp.Example.com/x' 'https://u:pw@myapp.example.com/x' 'https://myapp.example.com:8443/x' 'https://myapp.example.com' 'https://myapp.example.com./x'; do
    write_input "tests/api.spec.ts" "const base = \"$url\";"
    run_detector
    echo "$url -> $status: $output"
    [ "$status" -eq 2 ]
    [[ "$output" =~ "BLOCKED" ]]
  done
}

@test "enforce: documentation files still only warn about external links, and say why" {
  enforce_config
  write_input "docs/notes.md" "See https://www.acme.com/pricing for details."
  run_detector
  [ "$status" -eq 0 ]
  [[ "$output" =~ "WARNING" ]]
}

@test "a malformed qa-config.json: unattended is BLOCKED, attended is warned" {
  printf '{ not json' > "$TEST_TMP/qa-config.json"
  write_input "tests/api.spec.ts" 'const base = "https://staging.acme.com/x";'
  run env QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$DETECTOR' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "not valid JSON" ]]
  run_detector
  [ "$status" -eq 0 ]
  [[ "$output" =~ "not valid JSON" ]]
}

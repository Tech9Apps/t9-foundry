#!/usr/bin/env bats
# Tests for hooks/prod-guard.sh — Layer 3 production safety guard.
# The hook reads a JSON object from stdin with .tool_input.command and
# exits 2 (blocking) when the command targets a production environment.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
GUARD="$REPO_ROOT/hooks/prod-guard.sh"
FIXTURES="$BATS_TEST_DIRNAME/fixtures"

setup() {
  unset QA_AUTONOMOUS QA_HARNESS_DIR CLAUDE_PROJECT_DIR # hermetic: an exported autonomous/harness env must not change what these tests mean
  TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/qa-test.XXXXXX")"
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

# ── Invalid regex patterns ────────────────────────────────────────────────────

@test "skips invalid regex pattern in prod patterns and emits a warning" {
  # Staging URL — should not be blocked; invalid pattern should warn, not crash
  guard_input "curl https://staging.testapp.example.com/health" "invalid-regex-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "WARNING" ]]
}

@test "still blocks on valid pattern when config also contains an invalid pattern" {
  guard_input "curl https://testapp.example.com/" "invalid-regex-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
}

# ── Heuristic fallback stays on once prod patterns are configured ────────────

@test "still warns on a suspicious URL outside the configured patterns, even when patterns exist" {
  guard_input "curl https://otherapp.io/dashboard" "prod-url-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "WARNING" ]]
}

# ── Enforce mode (unattended runs fail closed) ───────────────────────────────

@test "enforce mode via config: blocks a suspicious URL instead of warning" {
  guard_input "curl https://otherapp.io/dashboard" "enforce-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
  [[ "$output" =~ "allowedUrlPatterns" ]]
}

@test "enforce mode via QA_AUTONOMOUS=1: blocks even when the config says warn" {
  guard_input "curl https://otherapp.io/dashboard" "prod-url-config.json"
  run env QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "warn mode (default) still only warns on the same URL" {
  guard_input "curl https://otherapp.io/dashboard" "prod-url-config.json"
  run env -u QA_AUTONOMOUS bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "WARNING" ]]
}

@test "enforce mode: tracker and code-host URLs are exempt" {
  guard_input "curl -fsS https://github.com/Tech9Apps/t9-foundry/issues/1" "enforce-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
}

@test "enforce mode: URLs matching allowedUrlPatterns are exempt" {
  guard_input "curl https://partner.io/guide/setup" "enforce-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
}

@test "enforce mode: a staging URL in the same command does not excuse a production-looking one" {
  guard_input "curl https://staging.myapp.example.com/health && curl https://otherapp.io/admin" "enforce-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "otherapp.io" ]]
}

@test "enforce mode: a staging-only command passes" {
  guard_input "curl https://staging.myapp.example.com/health" "enforce-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
}

@test "blockOnSuspiciousUrls=false silences the heuristic in warn mode (jq '// true' used to ignore it)" {
  guard_input "curl https://otherapp.io/dashboard" "azure-config.json"
  run env -u QA_AUTONOMOUS bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "WARNING" ]]
}

@test "enforce mode never overrides an explicit blockOnSuspiciousUrls=false opt-out" {
  # azure-config.json sets blockOnSuspiciousUrls=false; the explicit opt-out is honored.
  guard_input "curl https://otherapp.io/dashboard" "azure-config.json"
  run env QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
}

# ── cwd-independent config resolution ─────────────────────────────────────────

@test "resolves qa-config.json via CLAUDE_PROJECT_DIR when the tool's cwd has no config" {
  # qa-config.json is gitignored repo-wide, so build the CLAUDE_PROJECT_DIR
  # fixture at runtime (like guard_input does for cwd) instead of committing
  # a file with that literal name under tests/fixtures/.
  local project_dir="$(mktemp -d "${TMPDIR:-/tmp}/qa-test.XXXXXX")"
  cp "$FIXTURES/prod-url-config.json" "$project_dir/qa-config.json"
  guard_input "curl https://myapp.example.com/api/health"
  run env CLAUDE_PROJECT_DIR="$project_dir" bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  rm -rf "$project_dir"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

# ── Additional env var patterns ───────────────────────────────────────────────

@test "blocks FLASK_ENV set to production value" {
  # Constructed at runtime — literal trigger string is not present in this source file
  local cmd="FLASK_ENV"
  cmd="${cmd}=production flask test"
  guard_input "$cmd"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "blocks MIX_ENV set to prod value" {
  local cmd="MIX_ENV"
  cmd="${cmd}=prod mix test"
  guard_input "$cmd"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "blocks DJANGO_SETTINGS_MODULE pointing at production settings" {
  local cmd="DJANGO_SETTINGS_MODULE=myapp.settings"
  cmd="${cmd}.production python manage.py test"
  guard_input "$cmd"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

# ── Review findings: the heuristic reads the HOST, and every spelling of a configured pattern is caught ─────────────────

# Config helper for the cases below: enforce mode plus the given prodUrlPatterns (JSON array, default none).
enforce_config() {
  jq -n --argjson p "${1:-[]}" '{productionProtection:{mode:"enforce",prodUrlPatterns:$p}}' > "$TEST_TMP/qa-config.json"
}
run_guard() { run env -u QA_AUTONOMOUS bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"; }

@test "enforce: dev/test/qa/staging in a URL's path, query, userinfo or TLD no longer excuses it (it used to skip the heuristic)" {
  enforce_config
  for cmd in \
    'curl https://prod.mybank.com/api/latest' \
    'curl https://shop.acme.com/login?x=test' \
    'curl https://shop.acme.com/dev/x' \
    'curl https://shop.acme.com/qa/x#staging' \
    'curl https://acme.dev/x' \
    'curl https://devices.acme.com/' \
    'curl https://aqua.com/' \
    'curl https://staging.acme.com@evil.com/' \
    'curl https://test-prod.acme.com/'; do
    guard_input "$cmd"
    run_guard
    echo "$cmd -> $status: $output"
    [ "$status" -eq 2 ]
  done
}

@test "enforce: any host that is not recognizably a test environment blocks — www, api, apex without a path, ports, two-part TLDs, numeric and IPv6 hosts" {
  enforce_config
  for cmd in \
    'curl https://www.acme.com/x' \
    'curl https://api.acme.com/v1/users' \
    'curl https://acme.com' \
    'curl https://acme.co.uk/' \
    'curl https://acme.com:8443/' \
    'curl https://x@acme.com/' \
    'curl https://app.acme.com' \
    'curl http://134744072/' \
    'curl http://0x08080808/' \
    'curl "https://[2001:db8::1]/"'; do
    guard_input "$cmd"
    run_guard
    echo "$cmd -> $status: $output"
    [ "$status" -eq 2 ]
  done
}

@test "enforce: recognizably-not-production hosts still pass (staging/qa/dev labels, reserved TLDs, loopback and private addresses)" {
  enforce_config
  for cmd in \
    'curl https://staging.acme.com/x' \
    'curl https://acme-staging.com/' \
    'curl https://qa.acme.com' \
    'curl http://localhost:3000' \
    'curl http://127.0.0.1:8080' \
    'curl http://10.1.2.3' \
    'curl http://192.168.1.5/x' \
    'curl http://[::1]:3000' \
    'curl http://2130706433/' \
    'curl https://acme.test'; do
    guard_input "$cmd"
    run_guard
    echo "$cmd -> $status: $output"
    [ "$status" -eq 0 ]
  done
}

@test "a configured production pattern matches every spelling of the host: case, userinfo, port, no path, query, fragment, trailing dot, numeric IP" {
  jq -n '{productionProtection:{prodUrlPatterns:["://myapp\\.example\\.com/","myapp\\.com$","^http://203\\.0\\.113\\.7"]}}' > "$TEST_TMP/qa-config.json"
  for cmd in \
    'curl https://myapp.example.com/x' \
    'curl https://MyApp.Example.com/x' \
    'curl https://staging@myapp.example.com/x' \
    'curl https://user:pw@myapp.example.com/x' \
    'curl https://myapp.example.com:8443/x' \
    'curl https://myapp.example.com' \
    'curl https://myapp.example.com?x=1' \
    'curl https://myapp.example.com#frag' \
    'curl https://myapp.example.com./x' \
    'curl https://myapp.com:8443' \
    'curl https://MYAPP.COM/' \
    'curl http://3405803783/' \
    'curl http://0xcb007107/x'; do
    guard_input "$cmd"
    for mode in warn enforce; do
      if [ "$mode" = enforce ]; then run env QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"; else run_guard; fi
      echo "[$mode] $cmd -> $status: $output"
      [ "$status" -eq 2 ]
      [[ "$output" =~ "BLOCKED" ]]
    done
  done
}

@test "enforce: a host held in a shell variable cannot be verified, so it blocks; in warn mode it only warns" {
  enforce_config
  for cmd in 'H=myapp.example.com; curl https://$H/x' 'curl https://${HOST}/x' 'curl https://$(hostname)/x'; do
    guard_input "$cmd"
    run_guard
    echo "$cmd -> $status: $output"
    [ "$status" -eq 2 ]
    [[ "$output" =~ "UNVERIFIABLE_HOST" ]]
  done
  jq -n '{productionProtection:{mode:"warn"}}' > "$TEST_TMP/qa-config.json"
  guard_input 'curl https://$H/x'
  run_guard
  [ "$status" -eq 0 ]
  [[ "$output" =~ "WARNING" ]]
}

@test "allowedUrlPatterns cannot be satisfied by text in the query string or fragment of some other URL" {
  jq -n '{productionProtection:{mode:"enforce",allowedUrlPatterns:["://partner\\.io/guide"]}}' > "$TEST_TMP/qa-config.json"
  for cmd in 'curl https://evil.com/?x=://partner.io/guide' 'curl https://evil.com/x#://partner.io/guide'; do
    guard_input "$cmd"
    run_guard
    echo "$cmd -> $status: $output"
    [ "$status" -eq 2 ]
  done
  guard_input 'curl https://partner.io/guide'
  run_guard
  [ "$status" -eq 0 ]
}

@test "the test environment's own host is allowed in enforce mode, and only that exact host" {
  jq -n '{environments:{testEnvironmentBaseUrl:"https://check9.tech9app.com"},productionProtection:{mode:"enforce"}}' > "$TEST_TMP/qa-config.json"
  guard_input 'curl https://check9.tech9app.com/api/health'
  run_guard
  [ "$status" -eq 0 ]
  guard_input 'curl https://api.check9.tech9app.com/health'
  run_guard
  [ "$status" -eq 2 ]
}

@test "a malformed qa-config.json: an unattended run is BLOCKED (it used to fall through with no patterns); an attended one is warned" {
  printf '{ not json' > "$TEST_TMP/qa-config.json"
  guard_input 'curl https://www.acme.com/x'
  run env QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "not valid JSON" ]]
  guard_input 'curl https://staging.acme.com/x'
  run env QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]   # even a harmless command: the guard cannot know the patterns, so it does not guess
  run_guard
  [ "$status" -eq 0 ]
  [[ "$output" =~ "NOT being applied" ]]
}

@test "without node the URL checks cannot run: an unattended run is blocked, an attended one is warned" {
  enforce_config
  guard_input 'curl https://staging.acme.com/x'
  # a PATH with jq, bash and coreutils but no node
  run env -i HOME="$HOME" PATH="/usr/bin:/bin" QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "node is not installed" ]]
  jq -n '{productionProtection:{mode:"warn"}}' > "$TEST_TMP/qa-config.json"
  run env -i HOME="$HOME" PATH="/usr/bin:/bin" bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "node is not installed" ]]
}

@test "a command with several URLs is judged URL by URL: one bad URL blocks however many good ones surround it" {
  enforce_config
  guard_input 'curl https://staging.acme.com/a && curl http://localhost:3000/b && curl https://www.acme.com/c && curl https://github.com/x/y'
  run_guard
  [ "$status" -eq 2 ]
  [[ "$output" =~ "www.acme.com" ]]
}

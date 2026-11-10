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
# A fully configured enforce-mode workspace (enforce refuses a config with no patterns or no staging URL, see the last section), whose one
# production pattern matches nothing these tests use. Pass a JSON array to use other patterns.
enforce_config() {
  local patterns='["://prod\\.never-used\\.invalid/"]'
  [ -n "${1:-}" ] && patterns="$1"
  jq -n --argjson p "$patterns" '{environments:{testEnvironmentBaseUrl:"https://staging.never-used.invalid"},productionProtection:{mode:"enforce",prodUrlPatterns:$p}}' > "$TEST_TMP/qa-config.json"
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
  jq -n '{environments:{testEnvironmentBaseUrl:"https://staging.never-used.invalid"},productionProtection:{mode:"enforce",prodUrlPatterns:["://prod\\.never-used\\.invalid/"],allowedUrlPatterns:["://partner\\.io/guide"]}}' > "$TEST_TMP/qa-config.json"
  for cmd in 'curl https://evil.com/?x=://partner.io/guide' 'curl https://evil.com/x#://partner.io/guide'; do
    guard_input "$cmd"
    run_guard
    echo "$cmd -> $status: $output"
    [ "$status" -eq 2 ]
    [[ "$output" =~ "UNRECOGNIZED_HOST" ]]   # blocked because evil.com is unrecognized, not because the config was incomplete
  done
  guard_input 'curl https://partner.io/guide'
  run_guard
  [ "$status" -eq 0 ]
}

@test "the test environment's own host is allowed in enforce mode, and only that exact host" {
  jq -n '{environments:{testEnvironmentBaseUrl:"https://check9.tech9app.com"},productionProtection:{mode:"enforce",prodUrlPatterns:["://prod\\.never-used\\.invalid/"]}}' > "$TEST_TMP/qa-config.json"
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

# ── Every spelling of a URL that a command can use ───────────────────────────
# curl and browsers accept far more than "https://host/path": "https:/host", "http:///host", a bare "host/path", "user@host", "//host".
# The guard used to read only "https?://" and let the rest through unchecked, in every mode.

# guard_status <command> <config fixture> [env assignment...] → the hook's exit code, output in $output
guard_status() {
  local cmd="$1" config="$2"; shift 2
  guard_input "$cmd" "$config"
  run env "$@" bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
}

@test "a production URL is blocked in every spelling curl or a browser accepts, in warn mode and in enforce mode" {
  for cmd in \
    'curl https://myapp.example.com/x' \
    'curl https:/myapp.example.com/x' \
    'curl HTTPS:/myapp.example.com/x' \
    'curl http:///myapp.example.com/x' \
    'curl https:myapp.example.com/x' \
    'curl //myapp.example.com/x' \
    'curl --url=//myapp.example.com/x' \
    'curl myapp.example.com/x' \
    'curl myapp.example.com' \
    'curl -I MyApp.Example.Com:443' \
    'curl MYAPP.EXAMPLE.COM/x' \
    'curl user@myapp.example.com/x' \
    'wget -qO- myapp.example.com/x' \
    'BASE=myapp.example.com/x npm test' \
    'curl ftp://myapp.example.com/x' \
    'curl sftp://user@myapp.example.com/x'; do
    for env in QA_PROBE=warn QA_AUTONOMOUS=1; do
      guard_status "$cmd" "prod-url-config.json" "$env"
      [ "$status" -eq 2 ] || { echo "NOT BLOCKED ($env): $cmd"; echo "$output"; false; }
      [[ "$output" =~ "BLOCKED" ]]
    done
  done
}

@test "enforce: an odd spelling of a URL to a host that is not recognizably a test environment blocks, exactly like the normal spelling" {
  for cmd in 'curl https:/www.bank-of-example.net/transfer' 'curl http:///www.bank-of-example.net/transfer' 'curl //www.bank-of-example.net/transfer' 'curl https:www.bank-of-example.net/transfer'; do
    guard_status "$cmd" "enforce-config.json"
    [ "$status" -eq 2 ] || { echo "NOT BLOCKED: $cmd"; echo "$output"; false; }
    [[ "$output" =~ "bank-of-example.net" ]]
  done
  guard_status 'curl https:/www.bank-of-example.net/transfer' "empty-patterns-config.json" QA_AUTONOMOUS=1
  [ "$status" -eq 2 ]
}

@test "warn: an odd spelling of an unrecognized host only warns, like the normal spelling" {
  guard_status 'curl https:/otherapp.io/dashboard' "prod-url-config.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "WARNING" ]]
  [[ "$output" =~ "otherapp.io" ]]
}

@test "enforce: odd spellings of the staging URL, a code host and an allowed pattern still pass" {
  for cmd in 'curl https:/staging.myapp.example.com/health' 'curl //staging.myapp.example.com/health' 'curl staging.myapp.example.com/health' \
             'curl https:/github.com/Tech9Apps/t9-foundry' 'curl https:/partner.io/guide/setup'; do
    guard_status "$cmd" "enforce-config.json"
    [ "$status" -eq 0 ] || { echo "BLOCKED: $cmd"; echo "$output"; false; }
  done
}

@test "ordinary commands that merely contain dots, slashes or at-signs are not mistaken for URLs" {
  for cmd in 'node app.config.js' 'cat package.json README.md' 'ls //tmp/x' 'ls /usr//local/bin' 'npm install left-pad@1.3.0' 'git log --since=2.weeks' \
             'curl -o out.json https://staging.myapp.example.com/x' 'echo "see https: for details"' 'echo "the https:scheme is optional here"' 'git commit -m "fix foo.bar/baz handling"' 'scp build.tar.gz deploy@staging.myapp.example.com:/srv'; do
    for env in QA_PROBE=warn QA_AUTONOMOUS=1; do
      guard_status "$cmd" "enforce-config.json" "$env"
      [ "$status" -eq 0 ] || { echo "WRONGLY BLOCKED ($env): $cmd"; echo "$output"; false; }
    done
  done
}

@test "a spelling with a backslash is still not guessed at: unverifiable, so enforce blocks and warn warns" {
  guard_status 'curl https:\\myapp.example.com\x' "enforce-config.json"
  [ "$status" -eq 2 ]
  guard_status 'curl https:\\otherapp.io\x' "prod-url-config.json"   # a host no production pattern names: still only a warning in warn mode
  [ "$status" -eq 0 ]
  [[ "$output" =~ "WARNING" ]]
}

# ── An unsafe configuration stops every command ──────────────────────────────
# Claude Code cannot block a session from a SessionStart hook (exit 2 there only shows the user a notice and the session goes on), so
# the checks that must stop an unattended run are made here, before each command, where exit 2 does block.

@test "enforce: with no qa-config.json at all, every command is blocked" {
  guard_input "echo hello"
  run env QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
  [[ "$output" =~ "qa-config.json" ]]
}

@test "enforce: with no production URL patterns configured, every command is blocked" {
  for fixture in empty-patterns-config.json enforce-empty-patterns-config.json; do
    guard_input "echo hello" "$fixture"
    run env QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
    [ "$status" -eq 2 ] || { echo "NOT BLOCKED: $fixture"; echo "$output"; false; }
    [[ "$output" =~ "prodUrlPatterns" ]]
  done
  guard_input "echo hello" "enforce-empty-patterns-config.json"   # enforce set by the config itself, no environment variable
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
}

@test "enforce: with no staging URL configured, every command is blocked" {
  guard_input "echo hello" "enforce-no-test-url-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "testEnvironmentBaseUrl" ]]
}

@test "in any mode, a staging URL that is itself a production URL blocks every command, and says which pattern and URL" {
  guard_input "echo hello" "prod-staging-url-config.json"
  for mode in warn enforce; do
    if [ "$mode" = enforce ]; then run env QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"; else run env -u QA_AUTONOMOUS bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"; fi
    [ "$status" -eq 2 ] || { echo "NOT BLOCKED ($mode)"; echo "$output"; false; }
    [[ "$output" =~ "testEnvironmentBaseUrl" ]]
    [[ "$output" =~ "https://myapp.example.com" ]]
    [[ "$output" =~ 'myapp\.example\.com' ]]
  done
}

@test "a staging URL that is production in another spelling (case, userinfo, port, trailing dot) is caught like any production URL" {
  for url in 'https://MYAPP.EXAMPLE.COM/' 'https://deploy@myapp.example.com:443/' 'https://myapp.example.com./'; do
    jq --arg u "$url" '.environments.testEnvironmentBaseUrl = $u' "$FIXTURES/prod-url-config.json" > "$TEST_TMP/qa-config.json"
    guard_input "echo hello"
    run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
    [ "$status" -eq 2 ] || { echo "NOT BLOCKED: $url"; echo "$output"; false; }
  done
}

@test "a correctly configured workspace is not held up: commands pass in warn and in enforce mode" {
  guard_input "echo hello" "enforce-config.json"
  run env QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
  guard_input "echo hello" "prod-url-config.json"
  run env -u QA_AUTONOMOUS bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
}

@test "warn mode: no config, no patterns or no staging URL only warns elsewhere (session start), it never stops a command here" {
  for fixture in empty-patterns-config.json missing-env-url.json; do
    guard_input "echo hello" "$fixture"
    run env -u QA_AUTONOMOUS bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
    [ "$status" -eq 0 ] || { echo "BLOCKED: $fixture"; echo "$output"; false; }
  done
}

@test "the reasons are written for Claude to read: they go to stderr, where a blocking hook's message reaches it" {
  guard_input "echo hello" "prod-staging-url-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json 2>&1 >/dev/null"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "testEnvironmentBaseUrl" ]]
}

@test "without jq an unattended run is blocked (the guard could not read the command at all), an attended one is warned" {
  mkdir -p "$TEST_TMP/bin"
  for t in bash cat dirname grep node sed tr head cut sort uniq printf; do p=$(command -v "$t" || true); [ -n "$p" ] && ln -sf "$p" "$TEST_TMP/bin/$t"; done
  [ ! -e "$TEST_TMP/bin/jq" ]
  cp "$FIXTURES/enforce-config.json" "$TEST_TMP/qa-config.json"
  jq -n --arg c 'curl https://www.bank-of-example.net/x' '{"tool_input":{"command":$c}}' > "$TEST_TMP/input.json"
  run env -i HOME="$HOME" PATH="$TEST_TMP/bin" QA_AUTONOMOUS=1 "$TEST_TMP/bin/bash" -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "jq" ]]
  # enforce set only by the config file (no environment variable): without jq it still has to be recognized
  run env -i HOME="$HOME" PATH="$TEST_TMP/bin" "$TEST_TMP/bin/bash" -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  # an attended (warn mode) run is told, and goes on
  cp "$FIXTURES/prod-url-config.json" "$TEST_TMP/qa-config.json"
  run env -i HOME="$HOME" PATH="$TEST_TMP/bin" "$TEST_TMP/bin/bash" -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "jq" ]]
}

@test "every reason a blocking hook gives is on stderr, none on stdout (stderr is what Claude Code shows Claude when a hook blocks)" {
  for cmd in 'NODE_ENV=production npm test' 'curl https://myapp.example.com/x' 'curl https://www.bank-of-example.net/x'; do
    guard_input "$cmd" "enforce-config.json"
    run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json 2>/dev/null"
    [ "$status" -eq 2 ]
    [ -z "$output" ] || { echo "stdout was not empty for: $cmd"; echo "$output"; false; }
    run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json 2>&1 >/dev/null"
    [[ "$output" =~ "BLOCKED" ]]
  done
}

@test "an allowedUrlPatterns match inside the PATH of another host allows nothing (the reviewer's repro, with the repo's own enforce fixture)" {
  guard_input "curl https://www.bank-of-example.net/go/https://partner.io/guide" "enforce-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "bank-of-example.net" ]]
  guard_input "curl https://partner.io/guide/setup" "enforce-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 0 ]
}

# ── The configs a new user is told to copy must themselves be safe ───────────
# README tells people to `cp qa-config.example.json qa-config.json`. Its production pattern "myapp\.com$" also matched its own staging URL
# (staging.myapp.com), so the config-safety check above would have refused every shell command on a user's first run.

@test "every shipped example config passes the config-safety check in warn and in enforce mode, and its staging URL really is allowed" {
  for f in qa-config.example.json projects/example.json demo/qa-config.demo.json examples/qa-config.demo.json; do
    for mode in warn enforce; do
      run bash -c "node '$REPO_ROOT/hooks/lib/url-guard.js' --config '$REPO_ROOT/$f' --mode $mode </dev/null | jq -c '[.configProblems[].code]'"
      [ "$output" = "[]" ] || { echo "$f ($mode): $output"; false; }
    done
    guard_input "echo hello"
    cp "$REPO_ROOT/$f" "$TEST_TMP/qa-config.json"
    run env QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
    [ "$status" -eq 0 ] || { echo "$f: a command is refused in enforce mode"; echo "$output"; false; }
  done
}

@test "the production patterns the examples and the /init skill teach are anchored, so they cannot match a staging host that merely ends the same way" {
  # unanchored "myapp\.com$" matches https://staging.myapp.com; the anchored form "://myapp\.com(/|:|$)" does not
  for f in qa-config.example.json projects/example.json examples/qa-config.demo.json; do
    run jq -r '.productionProtection.prodUrlPatterns[]' "$REPO_ROOT/$f"
    for pattern in $output; do
      [[ "$pattern" == *"://"* || "$pattern" == "^"* ]] || { echo "$f: unanchored pattern: $pattern"; false; }
    done
  done
  run grep -n 'suggest `myapp.com\$`' "$REPO_ROOT/.claude/skills/init.md"
  [ "$status" -ne 0 ]
}

# ── Where a URL ends, and what a backslash means ─────────────────────────────

@test "a production URL is found whatever shell punctuation follows it: ; | & , } and an escaped quote (warn and enforce)" {
  for cmd in \
    'curl -s https://myapp.example.com;echo done' \
    'curl -s https://myapp.example.com/x|jq .' \
    'curl -s https://myapp.example.com/x && echo ok' \
    'curl -s https://myapp.example.com/x&& echo ok' \
    'curl -s https://myapp.example.com,https://staging.myapp.example.com' \
    'echo {https://myapp.example.com}' \
    'bash -c "curl \"https://myapp.example.com\""' \
    "bash -c 'curl \\'https://myapp.example.com\\''"; do
    for env in QA_PROBE=warn QA_AUTONOMOUS=1; do
      guard_status "$cmd" "prod-url-config.json" "$env"
      [ "$status" -eq 2 ] || { echo "NOT BLOCKED ($env): $cmd"; echo "$output"; false; }
    done
  done
}

@test "enforce: ordinary unattended-run syntax with the staging or localhost URL is not blocked just because punctuation follows the URL" {
  for cmd in \
    'export BASE_URL=https://staging.myapp.example.com; npx playwright test' \
    'BASE_URL=http://localhost:3000; npx playwright test' \
    'wait-on http://localhost:3000&& npm test' \
    'curl -s http://localhost:3000|jq .' \
    'curl -s "http://localhost:3000/health",' \
    'npx wait-on http://localhost:3000 && BASE_URL=http://localhost:3000 npx playwright test'; do
    guard_status "$cmd" "enforce-config.json"
    [ "$status" -eq 0 ] || { echo "WRONGLY BLOCKED: $cmd"; echo "$output"; false; }
  done
}

@test "a URL is still unverifiable when the unverifiable part is inside the host (a variable), punctuation or not" {
  guard_status 'curl https://${HOST}/x; echo' "enforce-config.json"
  [ "$status" -eq 2 ]
  guard_status 'curl https://$HOST/x;echo' "enforce-config.json"
  [ "$status" -eq 2 ]
}

@test "a backslash cannot hide a production host: a browser reads it as a slash, curl reads 'x\\@host' as host 'host'" {
  for cmd in \
    'curl -s https://staging.myapp.example.com\@myapp.example.com/' \
    'curl -s https://myapp.example.com\path' \
    'curl -s https:\\myapp.example.com\x' \
    'curl -s https://x@staging.myapp.example.com\@myapp.example.com/'; do
    for env in QA_PROBE=warn QA_AUTONOMOUS=1; do
      guard_status "$cmd" "prod-url-config.json" "$env"
      [ "$status" -eq 2 ] || { echo "NOT BLOCKED ($env): $cmd"; echo "$output"; false; }
    done
  done
}

@test "a backslash spelling of a host no pattern names is still unverifiable: warn warns, enforce blocks" {
  guard_status 'curl https:\\otherapp.io\x' "prod-url-config.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "WARNING" ]]
  guard_status 'curl https:\\otherapp.io\x' "enforce-config.json"
  [ "$status" -eq 2 ]
}

@test "one long token cannot stall the guard (the bare-host reader once took quadratic time: 100 KB took seconds, past the hook's timeout)" {
  run node -e '
    const { scan } = require(process.argv[1]);
    const cfg = { prodUrlPatterns: ["://myapp\\.example\\.com/"], mode: "warn" };
    for (const filler of ["a-".repeat(150000), "a.".repeat(150000), "a+".repeat(150000), "a@".repeat(150000), "0123456789abcdef.".repeat(20000), "ab:/".repeat(80000), "http:".repeat(60000), "//a.".repeat(60000), "x=a.b".repeat(60000)]) {
      const t0 = Date.now();
      const found = scan("echo " + filler + " ; curl https://myapp.example.com/x", cfg);
      const ms = Date.now() - t0;
      if (ms > 1500) { console.log("SLOW " + ms + "ms for " + filler.slice(0, 8)); process.exit(1); }
      if (!found.some((f) => f.reason === "PROD_PATTERN")) { console.log("MISSED the production URL after " + filler.slice(0, 8)); process.exit(1); }
    }
    console.log("OK");
  ' "$REPO_ROOT/hooks/lib/url-guard.js"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ "$output" = "OK" ]
}

@test "a malformed config that says mode enforce is treated as enforce, with or without jq reading it (it resolved to warn and let a production URL through)" {
  printf '{ "productionProtection": { "mode": "enforce", "prodUrlPatterns": ["://myapp\\\\.example\\\\.com/"], }, }' > "$TEST_TMP/qa-config.json"
  jq -n '{tool_input:{command:"curl https://myapp.example.com/x"}}' > "$TEST_TMP/input.json"
  run env -u QA_AUTONOMOUS bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "not valid JSON" ]]
  run env -u QA_AUTONOMOUS bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json 2>&1 | head -1"
  [[ "$output" =~ "BLOCKED" ]]
}

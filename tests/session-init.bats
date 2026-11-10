#!/usr/bin/env bats
# Tests for hooks/session-init.sh — Layer 2 production safety notice.
# The hook reads qa-config.json from the current directory and either exits 0 (safe) or exits 2 when production is misconfigured.
# Exit 2 from a SessionStart hook does NOT stop the session: Claude Code shows the user the stderr text as a notice and carries on.
# What stops an unsafe run is hooks/prod-guard.sh (tests/prod-guard.bats, "An unsafe configuration stops every command").

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
INIT_HOOK="$REPO_ROOT/hooks/session-init.sh"
FIXTURES="$BATS_TEST_DIRNAME/fixtures"

setup() {
  unset QA_AUTONOMOUS QA_HARNESS_DIR CLAUDE_PROJECT_DIR # hermetic: an exported autonomous/harness env must not change what these tests mean
  TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/qa-test.XXXXXX")"
}

teardown() {
  rm -rf "$TEST_TMP"
}

# ── Missing config ────────────────────────────────────────────────────────────

@test "exits 0 and prompts /init when qa-config.json is absent" {
  run bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "/init" ]]
}

@test "does not show workspace summary when config is absent" {
  run bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "Ticket source" ]]
}

# ── Valid config ──────────────────────────────────────────────────────────────

@test "exits 0 and shows workspace summary for a valid config" {
  cp "$FIXTURES/valid-config.json" "$TEST_TMP/qa-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "Test App" ]]
}

@test "displays the ticket source type in the summary" {
  cp "$FIXTURES/valid-config.json" "$TEST_TMP/qa-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "github" ]]
}

@test "displays the test environment URL in the summary" {
  cp "$FIXTURES/valid-config.json" "$TEST_TMP/qa-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "staging.testapp.example.com" ]]
}

# ── Production URL detection ──────────────────────────────────────────────────

@test "exits 2 (a notice to the user) when testEnvironmentBaseUrl matches a prod pattern" {
  cp "$FIXTURES/prod-staging-url-config.json" "$TEST_TMP/qa-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "CRITICAL" ]]
}

@test "reports that the staging URL is a production URL" {
  cp "$FIXTURES/prod-staging-url-config.json" "$TEST_TMP/qa-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "production" ]]
}

# ── Token warnings ────────────────────────────────────────────────────────────

@test "warns about missing AZURE_DEVOPS_PAT when ticketSource is azure" {
  cp "$FIXTURES/azure-config.json" "$TEST_TMP/qa-config.json"
  run env -u AZURE_DEVOPS_PAT bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "AZURE_DEVOPS_PAT" ]]
}

@test "does not warn about AZURE_DEVOPS_PAT when it is set" {
  cp "$FIXTURES/azure-config.json" "$TEST_TMP/qa-config.json"
  run env AZURE_DEVOPS_PAT=test_pat bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "AZURE_DEVOPS_PAT is not set" ]]
}

@test "warns about missing CLICKUP_TOKEN when ticketSource is clickup" {
  cp "$FIXTURES/clickup-config.json" "$TEST_TMP/qa-config.json"
  run env -u CLICKUP_TOKEN bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "CLICKUP_TOKEN" ]]
}

@test "does not warn about CLICKUP_TOKEN when it is set" {
  cp "$FIXTURES/clickup-config.json" "$TEST_TMP/qa-config.json"
  run env CLICKUP_TOKEN=test_token bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "CLICKUP_TOKEN is not set" ]]
}

@test "warns about missing GITLAB_TOKEN when ticketSource is gitlab" {
  cp "$FIXTURES/gitlab-config.json" "$TEST_TMP/qa-config.json"
  run env -u GITLAB_TOKEN bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "GITLAB_TOKEN" ]]
}

@test "warns about missing BITBUCKET_TOKEN when ticketSource is bitbucket" {
  cp "$FIXTURES/bitbucket-config.json" "$TEST_TMP/qa-config.json"
  run env -u BITBUCKET_TOKEN bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "BITBUCKET_TOKEN" ]]
}

@test "warns when ticketSource is bitbucket and no username is configured" {
  cp "$FIXTURES/bitbucket-config.json" "$TEST_TMP/qa-config.json"
  run env BITBUCKET_TOKEN=x bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "bitbucket.username" ]]
}

# ── Enforce mode (unattended runs fail closed) ───────────────────────────────

@test "enforce mode: a missing qa-config.json is reported as not safe to run" {
  run env QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "NOT SAFE TO RUN" ]]
}

@test "enforce mode via QA_AUTONOMOUS=1: empty prodUrlPatterns is reported as not safe to run" {
  cp "$FIXTURES/empty-patterns-config.json" "$TEST_TMP/qa-config.json"
  run env QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "prodUrlPatterns" ]]
}

@test "enforce mode via config: empty prodUrlPatterns is reported as not safe to run" {
  cp "$FIXTURES/enforce-empty-patterns-config.json" "$TEST_TMP/qa-config.json"
  run env -u QA_AUTONOMOUS bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 2 ]
}

@test "enforce mode: a fully configured workspace starts and reports the guard mode" {
  cp "$FIXTURES/enforce-config.json" "$TEST_TMP/qa-config.json"
  run env -u QA_AUTONOMOUS bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "Guard mode:       enforce" ]]
}

@test "warn mode (default) reports the guard mode as warn" {
  cp "$FIXTURES/valid-config.json" "$TEST_TMP/qa-config.json"
  run env -u QA_AUTONOMOUS bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "Guard mode:       warn" ]]
}

@test "a malformed qa-config.json is reported with a clear message" {
  cp "$FIXTURES/malformed-config.json" "$TEST_TMP/qa-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "not valid JSON" ]]
}

# ── Empty production patterns ─────────────────────────────────────────────────

@test "warns when prodUrlPatterns is empty" {
  cp "$FIXTURES/empty-patterns-config.json" "$TEST_TMP/qa-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "prodUrlPatterns" ]]
}

@test "exits 0 (does not block) when prodUrlPatterns is empty" {
  cp "$FIXTURES/empty-patterns-config.json" "$TEST_TMP/qa-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 0 ]
}

# ── What the notice is, and that it agrees with the per-command guard ────────

@test "an unsafe configuration is reported on stderr (the only channel shown for exit 2), says it is a notice, and names the hook that does stop commands" {
  cp "$FIXTURES/prod-staging-url-config.json" "$TEST_TMP/qa-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK' 2>&1 >/dev/null"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "CRITICAL" ]]
  [[ "$output" =~ "notice" ]]
  [[ "$output" =~ "prod-guard.sh" ]]
  run bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK' 2>/dev/null"
  [ -z "$(echo "$output" | grep -E 'CRITICAL|NOT SAFE')" ]   # nothing alarming is left on stdout, where it would be read as context
}

@test "the same configuration problems stop the per-command guard: Layer 2 and Layer 3 ask the same reader" {
  GUARD="$REPO_ROOT/hooks/prod-guard.sh"
  jq -n '{tool_input:{command:"echo hello"}}' > "$TEST_TMP/input.json"
  for fixture in prod-staging-url-config.json enforce-empty-patterns-config.json enforce-no-test-url-config.json; do
    cp "$FIXTURES/$fixture" "$TEST_TMP/qa-config.json"
    run bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK' >/dev/null 2>&1"
    [ "$status" -eq 2 ] || { echo "session-init did not report $fixture"; false; }
    run bash -c "cd '$TEST_TMP' && bash '$GUARD' < input.json"
    [ "$status" -eq 2 ] || { echo "prod-guard did not stop a command for $fixture"; false; }
  done
}

@test "a staging URL that is production in another spelling is reported, like any production URL (it used to be a case-sensitive grep)" {
  for url in 'https://MYAPP.EXAMPLE.COM/' 'https://deploy@myapp.example.com:443/' 'https://myapp.example.com./'; do
    jq --arg u "$url" '.environments.testEnvironmentBaseUrl = $u' "$FIXTURES/prod-url-config.json" > "$TEST_TMP/qa-config.json"
    run bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
    [ "$status" -eq 2 ] || { echo "NOT REPORTED: $url"; echo "$output"; false; }
  done
}

@test "every unsafe-configuration notice, not only the production-URL one, goes to stderr and says it is a notice that prod-guard.sh backs" {
  cp "$FIXTURES/malformed-config.json" "$TEST_TMP/qa-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK' 2>&1 >/dev/null"
  [ "$status" -eq 2 ]; [[ "$output" =~ "notice" ]]; [[ "$output" =~ "prod-guard.sh" ]]
  cp "$FIXTURES/enforce-empty-patterns-config.json" "$TEST_TMP/qa-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK' 2>&1 >/dev/null"
  [ "$status" -eq 2 ]; [[ "$output" =~ "notice" ]]; [[ "$output" =~ "prod-guard.sh" ]]
  rm "$TEST_TMP/qa-config.json"
  run env QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK' 2>&1 >/dev/null"
  [ "$status" -eq 2 ]; [[ "$output" =~ "notice" ]]; [[ "$output" =~ "prod-guard.sh" ]]
}

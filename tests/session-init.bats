#!/usr/bin/env bats
# Tests for hooks/session-init.sh — Layer 2 production safety guard.
# The hook reads qa-config.json from the current directory and either
# exits 0 (safe) or exits 2 (blocking) when production is misconfigured.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
INIT_HOOK="$REPO_ROOT/hooks/session-init.sh"
FIXTURES="$BATS_TEST_DIRNAME/fixtures"

setup() {
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

@test "exits 2 when testEnvironmentBaseUrl matches a prod pattern" {
  cp "$FIXTURES/prod-staging-url-config.json" "$TEST_TMP/qa-config.json"
  run bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "CRITICAL" ]]
}

@test "reports the matched prod pattern when blocking" {
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

@test "enforce mode: a missing qa-config.json blocks the session" {
  run env QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "BLOCKED" ]]
}

@test "enforce mode via QA_AUTONOMOUS=1: empty prodUrlPatterns blocks the session" {
  cp "$FIXTURES/empty-patterns-config.json" "$TEST_TMP/qa-config.json"
  run env QA_AUTONOMOUS=1 bash -c "cd '$TEST_TMP' && bash '$INIT_HOOK'"
  [ "$status" -eq 2 ]
  [[ "$output" =~ "prodUrlPatterns" ]]
}

@test "enforce mode via config: empty prodUrlPatterns blocks the session" {
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

@test "a malformed qa-config.json blocks the session with a clear message" {
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

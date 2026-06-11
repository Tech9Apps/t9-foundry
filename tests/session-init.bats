#!/usr/bin/env bats
# Tests for hooks/session-init.sh — Layer 2 production safety guard.
# The hook reads qa-config.json from the current directory and either
# exits 0 (safe) or exits 2 (blocking) when production is misconfigured.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
INIT_HOOK="$REPO_ROOT/hooks/session-init.sh"
FIXTURES="$BATS_TEST_DIRNAME/fixtures"

setup() {
  TEST_TMP="$(mktemp -d)"
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

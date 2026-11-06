#!/usr/bin/env bats
# Tests for scripts/preflight.sh — the go/no-go gate for autonomous runs.
# Every case passes --skip-network so it never touches the network.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
PREFLIGHT="$REPO_ROOT/scripts/preflight.sh"
FIXTURES="$BATS_TEST_DIRNAME/fixtures"

setup() {
  TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/qa-test.XXXXXX")"
}

teardown() {
  rm -rf "$TEST_TMP"
}

# A baseline config that should pass: no ticket system, no app repo, patterns set.
go_config() {
  jq '.codeRepository.localPath = ""' "$FIXTURES/enforce-config.json" > "$TEST_TMP/go.json"
  echo "$TEST_TMP/go.json"
}

@test "GO for a fully configured workspace" {
  run env QA_AUTONOMOUS=1 bash "$PREFLIGHT" --skip-network --config "$(go_config)"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "GO:" ]]
}

@test "NO-GO when the config file does not exist" {
  run bash "$PREFLIGHT" --skip-network --config "$TEST_TMP/nope.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "qa-config.json not found" ]]
}

@test "NO-GO when the config is malformed JSON" {
  run bash "$PREFLIGHT" --skip-network --config "$FIXTURES/malformed-config.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "not valid JSON" ]]
}

@test "NO-GO when prodUrlPatterns is empty" {
  run env QA_AUTONOMOUS=1 bash "$PREFLIGHT" --skip-network --config "$FIXTURES/enforce-empty-patterns-config.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "prodUrlPatterns is empty" ]]
}

@test "NO-GO when the staging URL matches a production pattern" {
  run bash "$PREFLIGHT" --skip-network --config "$FIXTURES/prod-staging-url-config.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "matches production pattern" ]]
}

@test "NO-GO when a production pattern is not a valid regex" {
  run bash "$PREFLIGHT" --skip-network --config "$FIXTURES/invalid-regex-config.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "invalid production URL regex" ]]
}

@test "NO-GO when a required config section is missing" {
  jq 'del(.environments)' "$FIXTURES/enforce-config.json" > "$TEST_TMP/cfg.json"
  run bash "$PREFLIGHT" --skip-network --config "$TEST_TMP/cfg.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "required config section missing: environments" ]]
}

@test "NO-GO when the ticket source token env var is unset" {
  jq '.codeRepository.localPath = ""' "$FIXTURES/azure-config.json" > "$TEST_TMP/cfg.json"
  run env -u AZURE_DEVOPS_PAT bash "$PREFLIGHT" --skip-network --config "$TEST_TMP/cfg.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "AZURE_DEVOPS_PAT is not set" ]]
}

@test "GO when the ticket source token env var is set" {
  jq '.codeRepository.localPath = ""' "$FIXTURES/azure-config.json" > "$TEST_TMP/cfg.json"
  run env AZURE_DEVOPS_PAT=x bash "$PREFLIGHT" --skip-network --config "$TEST_TMP/cfg.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "AZURE_DEVOPS_PAT is set" ]]
}

@test "NO-GO for bitbucket without a username" {
  jq '.codeRepository.localPath = ""' "$FIXTURES/bitbucket-config.json" > "$TEST_TMP/cfg.json"
  run env BITBUCKET_TOKEN=x bash "$PREFLIGHT" --skip-network --config "$TEST_TMP/cfg.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "bitbucket.username is not set" ]]
}

@test "Jira in an autonomous run warns that headless Jira is not supported yet" {
  jq '.ticketSource = {"type":"jira","jira":{"cloudId":"x.atlassian.net","projectKey":"ABC"}} | .codeRepository.localPath = ""' \
    "$FIXTURES/enforce-config.json" > "$TEST_TMP/cfg.json"
  run env QA_AUTONOMOUS=1 bash "$PREFLIGHT" --skip-network --config "$TEST_TMP/cfg.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "interactive login" ]]
}

@test "NO-GO when the app repo .env.test has no QA_HARNESS_DIR" {
  mkdir -p "$TEST_TMP/app"
  printf 'BASE_URL=https://staging.myapp.example.com\n' > "$TEST_TMP/app/.env.test"
  jq --arg p "$TEST_TMP/app" '.codeRepository.localPath = $p' "$FIXTURES/enforce-config.json" > "$TEST_TMP/cfg.json"
  run bash "$PREFLIGHT" --skip-network --config "$TEST_TMP/cfg.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no QA_HARNESS_DIR" ]]
}

@test "NO-GO when QA_HARNESS_DIR points somewhere without a qa-config.json" {
  mkdir -p "$TEST_TMP/app" "$TEST_TMP/empty"
  printf 'QA_HARNESS_DIR=%s\n' "$TEST_TMP/empty" > "$TEST_TMP/app/.env.test"
  jq --arg p "$TEST_TMP/app" '.codeRepository.localPath = $p' "$FIXTURES/enforce-config.json" > "$TEST_TMP/cfg.json"
  run bash "$PREFLIGHT" --skip-network --config "$TEST_TMP/cfg.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "does not contain qa-config.json" ]]
}

@test "GO when QA_HARNESS_DIR resolves to a harness that has qa-config.json" {
  mkdir -p "$TEST_TMP/app" "$TEST_TMP/harness"
  cp "$FIXTURES/enforce-config.json" "$TEST_TMP/harness/qa-config.json"
  printf 'QA_HARNESS_DIR=%s\n' "$TEST_TMP/harness" > "$TEST_TMP/app/.env.test"
  jq --arg p "$TEST_TMP/app" '.codeRepository.localPath = $p' "$FIXTURES/enforce-config.json" > "$TEST_TMP/cfg.json"
  run bash "$PREFLIGHT" --skip-network --config "$TEST_TMP/cfg.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "resolves to this harness" ]]
}

@test "warns (not fails) when the heuristic is disabled in enforce mode" {
  jq '.productionProtection.blockOnSuspiciousUrls = false' "$(go_config)" > "$TEST_TMP/cfg.json"
  run env QA_AUTONOMOUS=1 bash "$PREFLIGHT" --skip-network --config "$TEST_TMP/cfg.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "blockOnSuspiciousUrls is false" ]]
}

@test "rejects an unknown option" {
  run bash "$PREFLIGHT" --bogus
  [ "$status" -eq 2 ]
}

# ── Review findings ───────────────────────────────────────────────────────────────────────────────────────────────────

@test "NO-GO when the staging URL matches a production pattern in a different spelling (case, userinfo, port, trailing dot)" {
  for url in 'https://MyApp.Example.com/' 'https://qa@myapp.example.com/' 'https://myapp.example.com:8443/' 'https://myapp.example.com./' 'https://myapp.example.com'; do
    jq --arg u "$url" '.environments.testEnvironmentBaseUrl = $u | .codeRepository.localPath = "" | .productionProtection.prodUrlPatterns = ["://myapp\\.example\\.com/"]' \
      "$FIXTURES/enforce-config.json" > "$TEST_TMP/spelled.json"
    run bash "$PREFLIGHT" --skip-network --config "$TEST_TMP/spelled.json"
    echo "$url -> $status: $output"
    [ "$status" -eq 1 ]
    [[ "$output" =~ "matches production pattern" ]]
  done
}

@test "a staging URL that matches a production pattern is NEVER contacted (preflight used to curl it after failing it)" {
  mkdir -p "$TEST_TMP/bin"
  printf '#!/bin/sh\necho called >> "%s/curl-calls"\necho 200\n' "$TEST_TMP" > "$TEST_TMP/bin/curl"
  chmod +x "$TEST_TMP/bin/curl"
  run env PATH="$TEST_TMP/bin:$PATH" bash "$PREFLIGHT" --config "$FIXTURES/prod-staging-url-config.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "matches production pattern" ]]
  [[ "$output" =~ "will not send a request to it" ]]
  [ ! -e "$TEST_TMP/curl-calls" ]
}

@test "the reachability check still runs for a staging URL that is NOT production" {
  mkdir -p "$TEST_TMP/bin"
  printf '#!/bin/sh\necho called >> "%s/curl-calls"\necho 200\n' "$TEST_TMP" > "$TEST_TMP/bin/curl"
  chmod +x "$TEST_TMP/bin/curl"
  run env QA_AUTONOMOUS=1 PATH="$TEST_TMP/bin:$PATH" bash "$PREFLIGHT" --config "$(go_config)"
  [ "$status" -eq 0 ]
  [ -e "$TEST_TMP/curl-calls" ]
}

@test "the Jira warning for autonomous runs does not point at a Phase 1 adapter that does not exist" {
  jq '.ticketSource = {"type":"jira","jira":{"cloudId":"x.atlassian.net","projectKey":"ABC"}} | .codeRepository.localPath = ""' "$FIXTURES/enforce-config.json" > "$TEST_TMP/jira.json"
  run env QA_AUTONOMOUS=1 bash "$PREFLIGHT" --skip-network --config "$TEST_TMP/jira.json"
  [[ "$output" =~ "run Jira projects interactively" ]]
  [[ ! "$output" =~ "Phase 1" ]]
}

#!/usr/bin/env bats
# Tests for qa-config.schema.json.
# Uses validate-schema.js (requires: npm install in tests/) to run ajv validation.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
VALIDATOR="$BATS_TEST_DIRNAME/validate-schema.js"
FIXTURES="$BATS_TEST_DIRNAME/fixtures"

setup() {
  if [ ! -f "$BATS_TEST_DIRNAME/node_modules/ajv/package.json" ]; then
    npm install --prefix "$BATS_TEST_DIRNAME" --silent 2>/dev/null
  fi
}

# ── Valid configurations ──────────────────────────────────────────────────────

@test "full valid config passes schema" {
  run node "$VALIDATOR" "$FIXTURES/valid-config.json"
  [ "$status" -eq 0 ]
}

@test "minimal valid config with type=none passes schema" {
  run node "$VALIDATOR" "$FIXTURES/prod-url-config.json"
  [ "$status" -eq 0 ]
}

@test "config with extra fields passes schema (additionalProperties not restricted)" {
  run node "$VALIDATOR" "$FIXTURES/extra-fields-config.json"
  [ "$status" -eq 0 ]
}

@test "config with ticketSource.type=azure passes schema" {
  run node "$VALIDATOR" "$FIXTURES/azure-config.json"
  [ "$status" -eq 0 ]
}

@test "jira config with cloudId passes schema" {
  run node "$VALIDATOR" "$FIXTURES/jira-cloudid-config.json"
  [ "$status" -eq 0 ]
}

# ── Invalid configurations ────────────────────────────────────────────────────

@test "config with invalid ticketSource.type fails schema" {
  run node "$VALIDATOR" "$FIXTURES/invalid-ticket-type.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "ticketSource" ]]
}

@test "config missing required project.name fails schema" {
  run node "$VALIDATOR" "$FIXTURES/missing-project-name.json"
  [ "$status" -eq 1 ]
}

@test "config missing required testEnvironmentBaseUrl fails schema" {
  run node "$VALIDATOR" "$FIXTURES/missing-env-url.json"
  [ "$status" -eq 1 ]
}

@test "error message identifies the failing field path" {
  run node "$VALIDATOR" "$FIXTURES/invalid-ticket-type.json"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "/ticketSource/type" ]]
}

#!/usr/bin/env bats
# The command prompts tell a model exactly how to call scripts/tracker/*. If the prose and the code
# drift apart, the model follows the prose and breaks. tests/helpers/commands-drift-check.js checks
# every claim the prose makes against the real code and schemas.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
CHECK="$BATS_TEST_DIRNAME/helpers/commands-drift-check.js"

setup() {
  TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/qa-test.XXXXXX")"
  # a private copy of everything the checker reads, so a test can corrupt the prose safely
  mkdir -p "$TEST_TMP/.claude" "$TEST_TMP/scripts"
  cp -R "$REPO_ROOT/.claude/commands" "$REPO_ROOT/.claude/agents" "$TEST_TMP/.claude/"
  cp -R "$REPO_ROOT/scripts/tracker" "$TEST_TMP/scripts/"
  cp -R "$REPO_ROOT/schemas" "$TEST_TMP/"
}
teardown() {
  rm -rf "$TEST_TMP"
}

@test "the command prose matches the tracker CLIs: operations, flags, example JSON, adapters, no leftover curl" {
  run node "$CHECK"
  [ "$status" -eq 0 ]
  [ "$output" = "OK" ]
}

@test "drift: a misspelled operation in a command is caught" {
  sed -i.bak 's|cli.js fetch --input|cli.js fetchh --input|' "$TEST_TMP/.claude/commands/fetch-ticket.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "not an operation" ]]
}

@test "drift: a flag the script does not define is caught" {
  sed -i.bak 's|--context-file tests/cases|--context-flie tests/cases|' "$TEST_TMP/.claude/commands/fetch-ticket.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "has no option --context-flie" ]]
}

@test "drift: an example JSON the schema would reject is caught" {
  sed -i.bak 's|"priority": "High",|"priority": "Urgent",|' "$TEST_TMP/.claude/commands/file-bug.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "invalid" ]]
}

@test "drift: a direct API call creeping back in for an adapter-backed source is caught" {
  printf '\n```bash\ncurl -s https://api.clickup.com/api/v2/task/1\n```\n' >> "$TEST_TMP/.claude/commands/post-tests.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "must go through the CLI" ]]
}

@test "drift: registering an adapter without updating the commands is caught" {
  # add a fake adapter to the registry in the private copy
  sed -i.bak "s|  azure: () => require('./azure'),|  azure: () => require('./azure'),\n  jira: () => require('./jira'),|" "$TEST_TMP/scripts/tracker/adapters/index.js"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ 'adapter "jira" is registered but missing' ]]
}

@test "the adapter-backed commands no longer contain the old hand-written API calls" {
  for f in fetch-ticket post-tests; do
    run grep -nE "api\.clickup\.com|dev\.azure\.com|gh issue|_apis/wit" "$REPO_ROOT/.claude/commands/$f.md"
    [ "$status" -eq 1 ]
  done
}

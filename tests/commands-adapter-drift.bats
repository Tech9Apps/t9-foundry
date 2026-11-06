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
  cp -R "$REPO_ROOT/scripts/tracker" "$REPO_ROOT/scripts/results" "$TEST_TMP/scripts/"
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

@test "drift: dropping an adapter from the agent's Step 6 bullet is caught" {
  sed -i.bak 's|github / clickup / azure / gitlab / bitbucket\*\* — through|github / clickup / azure** — through|' "$TEST_TMP/.claude/agents/Manual-Automation-test-generator.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ 'adapter "gitlab" is registered but missing from Step 6' ]]
}

@test "no command contains a direct API call any more (every tracker but Jira goes through an adapter)" {
  for f in "$REPO_ROOT"/.claude/commands/*.md; do
    run grep -nE "^\s*curl\s" "$f"
    [ "$status" -eq 1 ]
  done
}

@test "the adapter-backed commands no longer contain the old hand-written API calls" {
  for f in fetch-ticket post-tests; do
    run grep -nE "api\.clickup\.com|dev\.azure\.com|gh issue|_apis/wit" "$REPO_ROOT/.claude/commands/$f.md"
    [ "$status" -eq 1 ]
  done
}

# ── run-spec-tests.md → scripts/results/run.js, and the bug receipt ─────────────────

@test "drift: a run.js flag that does not exist is caught" {
  sed -i.bak 's|<path-to-spec-file> --headed|<path-to-spec-file> --headd|' "$TEST_TMP/.claude/commands/run-spec-tests.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "run.js has no option --headd" ]]
}

@test "drift: a --framework run.js has no recipe for is caught" {
  sed -i.bak 's|--framework playwright|--framework playwrite|' "$TEST_TMP/.claude/commands/run-spec-tests.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "not a framework run.js knows" ]]
}

@test "drift: telling the model to read a result field the schema does not define is caught" {
  sed -i.bak 's|`totals.passed`|`totals.passd`|' "$TEST_TMP/.claude/commands/run-spec-tests.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "totals.passd" ]]
}

@test "drift: going back to a list reporter's console output is caught" {
  printf '\nRun `npx playwright test --reporter=list` and read the summary line.\n' >> "$TEST_TMP/.claude/commands/run-spec-tests.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "list reporter" ]]
}

@test "drift: run-spec-tests.md no longer calling the runner is caught" {
  sed -i.bak 's|node scripts/results/run.js|node scripts/results/runn.js|' "$TEST_TMP/.claude/commands/run-spec-tests.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no longer calls scripts/results/run.js" ]]
}

@test "drift: a receipt example that lists different trackers than the schema is caught" {
  sed -i.bak 's#|gitlab|bitbucket|none"#|gitlab|none"#' "$TEST_TMP/.claude/commands/file-bug.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "receipt example lists trackers" ]]
}

@test "drift: a receipt example the schema would reject is caught" {
  sed -i.bak 's|"reproduced": true,|"reproduced": "yes",|' "$TEST_TMP/.claude/commands/file-bug.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "receipt example is invalid" ]]
}

# ── shell-string safety: text must never be pasted into a command line ─────────────────────────

# edit a copy of the prose with node (sed would need to escape every $ and quote in the text being corrupted)
corrupt() { # <file under the copy's .claude/commands> <from> <to>
  node -e '
    const fs = require("fs"); const [f, from, to] = process.argv.slice(1);
    const s = fs.readFileSync(f, "utf8"); if (!s.includes(from)) { console.error("test setup: text not found: " + from); process.exit(9); }
    fs.writeFileSync(f, s.split(from).join(to));' "$TEST_TMP/.claude/commands/$1" "$2" "$3"
}

@test "drift: the ticket id pasted back into a single-quoted --input string is caught" {
  corrupt fetch-ticket.md "--input-file tests/cases/.ticket-context/.fetch-input.json" "--input '{\"id\":\"\$ARGUMENTS\"}'"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "untrusted text must never be pasted into a shell string" ]]
}

@test "drift: a ticket-title <placeholder> pasted back into an inline search --input is caught" {
  corrupt file-bug.md "--input-file {testCasesDir}/bugs/.search.input.json" "--input '{\"query\":\"<2-4 words from the title>\",\"kind\":\"bug\"}'"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "untrusted text must never be pasted into a shell string" ]]
}

@test "drift: a command split over backslash-continued lines is checked as one command (a bad flag on line 2 is caught)" {
  corrupt post-tests.md "node scripts/tracker/post-tests.js --parent \$ARGUMENTS" "node scripts/tracker/post-tests.js \\
  --parent \$ARGUMENTS \\
  --bogus-flag"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "post-tests.js has no option --bogus-flag" ]]
}

@test "drift: a command that puts \$ARGUMENTS on a shell line without stating an allow-list for it is caught" {
  corrupt post-tests.md 'It must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`' 'It must be sensible'
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "post-tests.md:".*"never states an anchored allow-list" ]]
}

@test "drift: the profile commands (cp / diff on projects/\$ARGUMENTS.json) must state their allow-list too" {
  corrupt switch-project.md 'it must match `^[a-z0-9][a-z0-9-]{0,63}$`' 'it should look like a name'
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "switch-project.md:".*"never states an anchored allow-list" ]]
}

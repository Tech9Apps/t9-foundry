#!/usr/bin/env bats
# Cheap grep-based regression guards for prompt-file wording/logic drift.
# There is no way to unit-test markdown instructions executed by an LLM, but
# these catch known-bad strings reappearing after a refactor — cheaper than
# nothing, not a substitute for a manual dry-run of the actual pipeline.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"

@test "no command or agent file still says 'Jira ticket ID' (fast path is source-agnostic)" {
  run grep -rl "Jira ticket ID" "$REPO_ROOT/.claude/commands" "$REPO_ROOT/.claude/agents"
  [ "$status" -eq 1 ]
}

@test "run-spec-tests.md does not point users at the unrelated /run-tests skill" {
  run grep -rl "/run-tests <spec-file>" "$REPO_ROOT/.claude/commands" "$REPO_ROOT/.claude/agents"
  [ "$status" -eq 1 ]
}

@test "no curl call in the ticket-writing commands is missing -f/--max-time" {
  # Static guard: every 'curl' line in these three files must carry both flags.
  # Catches a new curl call added without the failure/timeout handling these
  # commands are supposed to have uniformly.
  local files=(
    "$REPO_ROOT/.claude/commands/fetch-ticket.md"
    "$REPO_ROOT/.claude/commands/post-tests.md"
    "$REPO_ROOT/.claude/commands/file-bug.md"
  )
  local bad
  bad=$(grep -nE '^\s*curl ' "${files[@]}" | grep -vE '\-f.*--max-time|--max-time.*-f' || true)
  [ -z "$bad" ]
}

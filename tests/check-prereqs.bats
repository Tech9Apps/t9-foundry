#!/usr/bin/env bats
# Smoke tests for scripts/check-prereqs.sh — no coverage existed for this
# script before; keep this minimal (it's an interactive report, not logic
# with branches worth exhaustively testing).

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
CHECK_SCRIPT="$REPO_ROOT/scripts/check-prereqs.sh"

@test "check-prereqs.sh runs without error" {
  run bash "$CHECK_SCRIPT"
  [ "$status" -eq 0 ] || [ "$status" -eq 1 ]
}

@test "check-prereqs.sh checks AZURE_DEVOPS_PAT alongside the other ticket-source tokens" {
  run grep -c "AZURE_DEVOPS_PAT" "$CHECK_SCRIPT"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
}

@test "check-prereqs.sh checks all four optional ticket-source tokens" {
  for var in AZURE_DEVOPS_PAT CLICKUP_TOKEN GITLAB_TOKEN BITBUCKET_TOKEN; do
    run grep -q "$var" "$CHECK_SCRIPT"
    [ "$status" -eq 0 ]
  done
}

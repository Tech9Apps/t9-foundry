#!/usr/bin/env bash
# Shared helper for hooks/*.sh — locate qa-config.json independent of the
# calling tool's current working directory.
#
# Checks $CLAUDE_PROJECT_DIR first (the workspace root Claude Code sets for
# the session) before falling back to the historical cwd-relative checks, so
# a hook still finds the config even if a skill changes directories (e.g.
# into codeRepository.localPath) before invoking a Bash/Write/Edit tool.
#
# Usage:
#   QA_CONFIG_PATH=$(resolve_qa_config) || QA_CONFIG_PATH="qa-config.json"
resolve_qa_config() {
  local candidates=()
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    candidates+=("$CLAUDE_PROJECT_DIR/qa-config.json")
  fi
  candidates+=("qa-config.json" "../qa-config.json" "../../qa-config.json")

  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -f "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

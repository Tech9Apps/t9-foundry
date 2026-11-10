#!/usr/bin/env bash
# Shared helpers for hooks/*.sh — guard mode and heuristic URL exemptions.
# Sourced (never executed). bash 3.2 compatible.
#
# Guard mode:
#   warn     (default) heuristic matches only print a WARNING — a human is watching.
#   enforce  heuristic matches BLOCK (exit 2) — nobody is watching, so a warning
#            is no guard at all. Selected by QA_AUTONOMOUS=1 or
#            qa-config.json > productionProtection.mode = "enforce".

# resolve_guard_mode <qa-config-path>  → prints "enforce" or "warn"
resolve_guard_mode() {
  if [ "${QA_AUTONOMOUS:-}" = "1" ]; then
    echo "enforce"
    return 0
  fi
  local mode="warn"
  if [ -n "${1:-}" ] && [ -f "$1" ]; then
    if ! { command -v jq >/dev/null 2>&1 && mode=$(jq -r '.productionProtection.mode // "warn"' "$1" 2>/dev/null); }; then
      # no jq, or the file is not valid JSON (jq cannot read it): a config that says it is enforce must not fall back to warn because of a stray comma
      mode="warn"
      if grep -Eq '"mode"[[:space:]]*:[[:space:]]*"enforce"' "$1" 2>/dev/null; then mode="enforce"; fi
    fi
  fi
  if [ "$mode" = "enforce" ]; then
    echo "enforce"
  else
    echo "warn"
  fi
}

# URL classification lives in hooks/lib/url-guard.js (one implementation, shared with the runtime guards' test table).

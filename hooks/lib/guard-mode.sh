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
    mode=$(jq -r '.productionProtection.mode // "warn"' "$1" 2>/dev/null || echo "warn")
  fi
  if [ "$mode" = "enforce" ]; then
    echo "enforce"
  else
    echo "warn"
  fi
}

# Hosts the pipeline legitimately talks to (trackers, code hosts, local dev).
# These are exempt from the suspicious-URL heuristic only — configured
# prodUrlPatterns are still checked first and always win.
BUILTIN_EXEMPT_URL_REGEX='^https?://([a-z0-9-]+\.)*(github\.com|githubusercontent\.com|gitlab\.com|bitbucket\.org|dev\.azure\.com|visualstudio\.com|api\.clickup\.com|atlassian\.net|atlassian\.com|localhost|127\.0\.0\.1)(:[0-9]+)?(/|$)'

# url_is_exempt <url> <qa-config-path>
# Returns 0 when the URL is a known-safe tracker/code host, or matches
# productionProtection.allowedUrlPatterns. Returns 1 otherwise.
url_is_exempt() {
  local url="$1"
  local cfg="${2:-}"

  if echo "$url" | grep -qiE -e "$BUILTIN_EXEMPT_URL_REGEX"; then
    return 0
  fi

  if [ -n "$cfg" ] && [ -f "$cfg" ]; then
    local allowed
    while IFS= read -r allowed; do
      [ -n "$allowed" ] || continue
      # Skip invalid regexes rather than treating them as a match (grep rc 2).
      local rc=0
      echo "" | grep -qE -e "$allowed" 2>/dev/null || rc=$?
      [ "$rc" -eq 2 ] && continue
      if echo "$url" | grep -qE -e "$allowed"; then
        return 0
      fi
    done < <(jq -r '.productionProtection.allowedUrlPatterns[]? // empty' "$cfg" 2>/dev/null || true)
  fi
  return 1
}

# extract_urls — reads text on stdin, prints one URL per line.
extract_urls() {
  grep -oE "https?://[^[:space:]'\"\`<>)]+" || true
}

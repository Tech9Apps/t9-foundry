#!/usr/bin/env bash
# PreToolUse hook (Bash) — Layer 3 production safety guard.
# Blocks any shell command that targets a production environment.
# Exit code 2 surfaces the blocking message to Claude.

set -euo pipefail

# When a PreToolUse hook blocks (exit 2), Claude Code shows Claude the hook's STDERR as the reason. Everything this script prints is a reason or
# a warning for someone to read, so it all goes to stderr; command substitutions below keep capturing their own output as before.
exec 1>&2

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/qa-config-path.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/guard-mode.sh"

INPUT=$(cat)

# Resolve qa-config.json independent of cwd (see lib/qa-config-path.sh)
QA_CONFIG_PATH=$(resolve_qa_config || echo "qa-config.json")

# Everything below reads the command out of the hook input with jq. Without it the guard sees nothing, so an unattended run must not go on.
if ! command -v jq >/dev/null 2>&1; then
  if [ "$(resolve_guard_mode "$QA_CONFIG_PATH")" = "enforce" ]; then
    echo "BLOCKED: jq is not installed, so this command cannot be read or checked." >&2
    echo "Guard mode is 'enforce' (QA_AUTONOMOUS=1 or productionProtection.mode), so the guard fails closed. Install jq (brew install jq)." >&2
    exit 2
  fi
  echo "WARNING: jq is not installed, so the production guard cannot read this command: it is NOT being checked. Install jq (brew install jq)." >&2
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# A config that exists but is not valid JSON would silently drop every production pattern. Unattended, that must not pass.
# (The URL checks below report it too; this catches it before anything else runs.)
if [ -f "$QA_CONFIG_PATH" ] && ! jq -e . "$QA_CONFIG_PATH" >/dev/null 2>&1; then
  if [ "$(resolve_guard_mode "$QA_CONFIG_PATH")" = "enforce" ]; then
    echo "BLOCKED: $QA_CONFIG_PATH is not valid JSON, so its production URL patterns cannot be applied."
    echo "Guard mode is 'enforce' (QA_AUTONOMOUS=1 or productionProtection.mode), so the guard fails closed. Fix qa-config.json."
    exit 2
  fi
  echo "WARNING: $QA_CONFIG_PATH is not valid JSON — production URL patterns are NOT being applied. Fix qa-config.json."
fi

# One run of the shared reader (hooks/lib/url-guard.js) per command: it reports problems with the configuration itself, handled just below,
# and the URLs in the command and what to do about each, handled at the end.
GUARD_MODE=$(resolve_guard_mode "$QA_CONFIG_PATH")
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN=$(command -v node || true)
RESULT=""
if [ -n "$NODE_BIN" ]; then
  RESULT=$(printf '%s' "$COMMAND" | "$NODE_BIN" "$HOOK_DIR/lib/url-guard.js" --config "$QA_CONFIG_PATH" --mode "$GUARD_MODE" 2>/dev/null || true)
fi

# An unsafe configuration stops every command. Claude Code cannot block a SESSION from a SessionStart hook (exit 2 there only shows the user a
# notice and the session carries on), so session-init.sh can only tell the user; the refusal that actually stops a run is made here, where exit 2
# does block, and it is made on the same facts: no config / no production patterns / no staging URL (enforce mode), or a staging URL that is
# itself a production URL (any mode). The reasons go to stderr, which is what Claude reads from a blocking hook.
CONFIG_PROBLEMS=$(echo "$RESULT" | jq -r '.configProblems[]?.message // empty' 2>/dev/null || true)
if [ -n "$CONFIG_PROBLEMS" ]; then
  {
    while IFS= read -r problem; do echo "BLOCKED: $problem"; done <<< "$CONFIG_PROBLEMS"
    echo "No shell command runs until qa-config.json is fixed. Edit it with the Write or Edit tool, or ask the user to; then retry."
  } >&2
  exit 2
fi

# Load production URL patterns from qa-config.json if available
PROD_PATTERNS=()
if [ -f "$QA_CONFIG_PATH" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && PROD_PATTERNS+=("$line")
  done < <(jq -r '.productionProtection.prodUrlPatterns[]? // empty' "$QA_CONFIG_PATH" 2>/dev/null || true)
fi

# Always block common production environment variable patterns
BLOCKED_ENV_PATTERNS=(
  "NODE_ENV=production"
  "RAILS_ENV=production"
  "APP_ENV=prod([^a-z]|$)"
  "APP_ENV=production"
  "DJANGO_ENV=production"
  "DJANGO_SETTINGS_MODULE=.*production"
  "FLASK_ENV=production"
  "MIX_ENV=prod"
  "--env=prod([^a-z]|$)"
  "--env=production"
  "--environment=production"
  "environment=production"
)

for pattern in "${BLOCKED_ENV_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qiE -e "$pattern"; then
    echo "BLOCKED: Command sets a production environment variable."
    echo "Pattern matched: $pattern"
    echo "Tests must never run against production. Check your environment configuration."
    echo "Configured test environment: $(jq -r '.environments.testEnvironmentBaseUrl // "not set"' "$QA_CONFIG_PATH" 2>/dev/null || echo 'not set')"
    exit 2
  fi
done

# Check command against configured production URL patterns
if [ "${#PROD_PATTERNS[@]}" -gt 0 ]; then
  for pattern in "${PROD_PATTERNS[@]}"; do
    if [ -z "$pattern" ]; then continue; fi
    # Pre-validate regex — grep exits 2 on invalid pattern, 1 on no match, 0 on match
    grep_rc=0
    echo "" | grep -qiE -e "$pattern" 2>/dev/null || grep_rc=$?
    if [ "$grep_rc" -eq 2 ]; then
      echo "WARNING: Skipping invalid production URL pattern: $pattern"
      echo "Fix productionProtection.prodUrlPatterns in qa-config.json to use valid regex."
      continue
    fi
    if echo "$COMMAND" | grep -qiE -e "$pattern"; then
      echo "BLOCKED: Command contains a production URL matching pattern: $pattern"
      echo "Tests must never run against production environments."
      echo "Your configured test environment is: $(jq -r '.environments.testEnvironmentBaseUrl // "not set"' "$QA_CONFIG_PATH" 2>/dev/null || echo 'not set')"
      exit 2
    fi
  done
fi

# URL checks: configured production patterns (matched against every normalized spelling of each URL: case, userinfo, port, trailing dot,
# query/fragment, numeric IPs) and the "is this recognizably NOT production?" heuristic. One implementation, hooks/lib/url-guard.js,
# shared with the runtime guards' test table (tests/fixtures/guard-cases.json).
fail_closed_or_warn() { # <message> — enforce mode blocks; otherwise it is only a warning
  if [ "$GUARD_MODE" = "enforce" ]; then
    echo "BLOCKED: $1"
    echo "Guard mode is 'enforce' (QA_AUTONOMOUS=1 or productionProtection.mode), so the guard fails closed."
    exit 2
  fi
  echo "WARNING: $1"
}

if [ -z "$NODE_BIN" ]; then
  fail_closed_or_warn "node is not installed, so URLs in this command cannot be checked (only the configured regexes above were applied)."
else
  if ! echo "$RESULT" | jq -e . >/dev/null 2>&1; then
    fail_closed_or_warn "the URL check failed to run, so URLs in this command cannot be verified."
  else
    CONFIG_ERROR=$(echo "$RESULT" | jq -r '.configError // empty')
    if [ -n "$CONFIG_ERROR" ]; then
      fail_closed_or_warn "$CONFIG_ERROR — its production patterns cannot be applied. Fix qa-config.json."
    fi

    # One finding per URL that is not allowed. A staging URL elsewhere in the same command never excuses another URL.
    while IFS=$'\t' read -r decision reason url detail; do
      [ -n "$decision" ] || continue
      if [ "$reason" = "PROD_PATTERN" ]; then
        echo "BLOCKED: Command contains a production URL matching pattern: $detail"
        echo "URL: $url"
        echo "Tests must never run against production environments."
        echo "Your configured test environment is: $(jq -r '.environments.testEnvironmentBaseUrl // "not set"' "$QA_CONFIG_PATH" 2>/dev/null || echo 'not set')"
        exit 2
      fi
      if [ "$decision" = "block" ]; then
        echo "BLOCKED: Command contains a URL that looks like production: $url"
        echo "Why: $reason. Guard mode is 'enforce' (QA_AUTONOMOUS=1 or productionProtection.mode), so anything not recognizably a test environment blocks."
        echo "If this URL is safe, add a regex for it to productionProtection.allowedUrlPatterns in qa-config.json."
        echo "If it is production, add it to productionProtection.prodUrlPatterns and use your staging URL instead."
        exit 2
      fi
      # warn mode: a human is watching, so say what is unverified and carry on
      echo "WARNING: Command may contain a production URL: $url"
      echo "Why: $reason. Configure productionProtection.prodUrlPatterns in qa-config.json to enable strict blocking."
    done < <(echo "$RESULT" | jq -r '.findings[] | [.decision, .reason, .url, (.detail // "")] | @tsv')
  fi
fi

exit 0

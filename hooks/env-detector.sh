#!/usr/bin/env bash
# PreToolUse hook (Write|Edit) — Layer 4 production safety guard.
# Scans file content being written or edited for production URLs and credentials.
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

# Everything below reads the tool input with jq. Without it the guard sees nothing, so an unattended run must not go on (as in prod-guard.sh).
if ! command -v jq >/dev/null 2>&1; then
  if [ "$(resolve_guard_mode "$QA_CONFIG_PATH")" = "enforce" ]; then
    echo "BLOCKED: jq is not installed, so this file content cannot be read or checked."
    echo "Guard mode is 'enforce' (QA_AUTONOMOUS=1 or productionProtection.mode), so the guard fails closed. Install jq (brew install jq)."
    exit 2
  fi
  echo "WARNING: jq is not installed, so the production guard cannot read this file content: it is NOT being checked. Install jq (brew install jq)."
  exit 0
fi

TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)

# Extract content based on tool type
CONTENT=""
case "$TOOL" in
  Write)
    CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty' 2>/dev/null || true)
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)
    ;;
  Edit|MultiEdit)
    CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // .tool_input.new_content // empty' 2>/dev/null || true)
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)
    ;;
  *)
    exit 0
    ;;
esac

if [ -z "$CONTENT" ]; then
  exit 0
fi

# Skip this hook for the hooks and config schema files themselves
case "$FILE_PATH" in
  *hooks/*.sh|*qa-config.schema.json|*qa-config.example.json|*prod-safety.md|*/CLAUDE.md)
    exit 0
    ;;
esac

# Skip Claude Code's own internal files (plans, memory) — those files document
# production env var names in a non-executable context and are not test artifacts.
case "$FILE_PATH" in
  $HOME/.claude/*)
    exit 0
    ;;
esac

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# A file named qa-config.json is the repair channel. While the configuration is unsafe prod-guard.sh refuses every shell command, so a Write or Edit is
# how it gets fixed, and it must not be judged against the broken config it replaces. A full Write is judged on the config it would CREATE (valid JSON, and
# the same checks prod-guard.sh makes before each command); an Edit is a fragment, so it only skips the "the current config is malformed" stop below.
# "The" qa-config.json means the one the guards read: the one resolved above, or (when there is none yet) one in the working directory or $CLAUDE_PROJECT_DIR.
# A file that is merely NAMED qa-config.json somewhere else (tests/qa-config.json, which test code could read URLs from) is scanned like any other.
canonical() { local d; d=$(cd "$(dirname "$1")" 2>/dev/null && pwd) || return 1; echo "$d/$(basename "$1")"; }
IS_CONFIG_FILE=0
if [ "$(basename "$FILE_PATH")" = "qa-config.json" ]; then
  TARGET=$(canonical "$FILE_PATH" || true)
  # exactly one file: the config that resolves; when there is none yet, where a new one would be found (the project dir, else here)
  if [ -f "$QA_CONFIG_PATH" ]; then CONFIG_TARGET="$QA_CONFIG_PATH"
  elif [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then CONFIG_TARGET="$CLAUDE_PROJECT_DIR/qa-config.json"
  else CONFIG_TARGET="$PWD/qa-config.json"; fi
  [ -n "$TARGET" ] && [ "$(canonical "$CONFIG_TARGET" || true)" = "$TARGET" ] && IS_CONFIG_FILE=1
fi
if [ "$IS_CONFIG_FILE" -eq 1 ] && [ "$TOOL" = "Write" ] && command -v node >/dev/null 2>&1; then
  JUDGED=$(printf '%s' "$CONTENT" | node "$HOOK_DIR/lib/url-guard.js" --judge-config --mode "$(resolve_guard_mode "$QA_CONFIG_PATH")" 2>/dev/null || true)
  if echo "$JUDGED" | jq -e . >/dev/null 2>&1; then
    if [ "$(echo "$JUDGED" | jq -r '.valid')" != "true" ]; then
      echo "BLOCKED: the new qa-config.json is not valid JSON ($(echo "$JUDGED" | jq -r '.error')), so the production guards could not read it."
      exit 2
    fi
    NEW_PROBLEMS=$(echo "$JUDGED" | jq -r '.configProblems[]?.message // empty')
    if [ -n "$NEW_PROBLEMS" ]; then
      while IFS= read -r problem; do echo "BLOCKED: the new qa-config.json would be unsafe: $problem"; done <<< "$NEW_PROBLEMS"
      exit 2
    fi
    exit 0
  fi
fi

# Load production URL patterns from qa-config.json
PROD_PATTERNS=()
if [ -f "$QA_CONFIG_PATH" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && PROD_PATTERNS+=("$line")
  done < <(jq -r '.productionProtection.prodUrlPatterns[]? // empty' "$QA_CONFIG_PATH" 2>/dev/null || true)
fi

# Check against configured production URL patterns
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
    if echo "$CONTENT" | grep -qiE -e "$pattern"; then
      MATCHED_LINE=$(echo "$CONTENT" | grep -niE -e "$pattern" | head -5)
      echo "BLOCKED: File content contains a production URL matching pattern: $pattern"
      echo "Matched content:"
      echo "$MATCHED_LINE"
      echo ""
      echo "Tests and test configuration must never reference production environments."
      echo "Use process.env.BASE_URL or qa-config.json's testEnvironmentBaseUrl instead."
      exit 2
    fi
  done
fi

# Check for hardcoded production environment variable assignments in test/config files
PROD_ENV_PATTERNS=(
  "NODE_ENV[[:space:]]*[=:][[:space:]]*['\"]?production"
  "RAILS_ENV[[:space:]]*[=:][[:space:]]*['\"]?production"
  "APP_ENV[[:space:]]*[=:][[:space:]]*['\"]?production"
  "APP_ENV[[:space:]]*[=:][[:space:]]*['\"]?prod['\"]?"
  "DJANGO_ENV[[:space:]]*[=:][[:space:]]*['\"]?production"
  "FLASK_ENV[[:space:]]*[=:][[:space:]]*['\"]?production"
  "MIX_ENV[[:space:]]*[=:][[:space:]]*['\"]?prod['\"]?"
)

for pattern in "${PROD_ENV_PATTERNS[@]}"; do
  if echo "$CONTENT" | grep -qiE -e "$pattern"; then
    MATCHED_LINE=$(echo "$CONTENT" | grep -niE -e "$pattern" | head -3)
    echo "BLOCKED: File content contains a production environment variable assignment."
    echo "Matched: $MATCHED_LINE"
    echo "Do not hardcode production environment settings in test files."
    exit 2
  fi
done

# Hardcoded URLs that are not recognizably a test environment. Configured production patterns are matched against every normalized
# spelling of each URL (case, userinfo, port, trailing dot, query/fragment, numeric IPs) and the heuristic reads the HOST's labels,
# never the whole URL — one implementation, hooks/lib/url-guard.js, shared with the runtime guards' test table. This always runs
# as an additional layer, even once prodUrlPatterns is configured: a configured list only covers what has been typed in.
GUARD_MODE=$(resolve_guard_mode "$QA_CONFIG_PATH")

# Documentation files legitimately link to external sites; they only ever warn.
case "$FILE_PATH" in
  *.md|*.markdown|*.txt|*.rst) IS_DOC_FILE=1 ;;
  *) IS_DOC_FILE=0 ;;
esac

unverified() { # <message> — enforce blocks (except documentation); otherwise only a warning
  if [ "$GUARD_MODE" = "enforce" ] && [ "$IS_DOC_FILE" -eq 0 ]; then
    echo "BLOCKED: $1"
    echo "Guard mode is 'enforce' (QA_AUTONOMOUS=1 or productionProtection.mode), so the guard fails closed."
    exit 2
  fi
  echo "WARNING: $1"
}

NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then
  unverified "node is not installed, so URLs in this file content cannot be checked (only the configured regexes above were applied)."
else
  RESULT=$(printf '%s' "$CONTENT" | "$NODE_BIN" "$HOOK_DIR/lib/url-guard.js" --config "$QA_CONFIG_PATH" --mode "$GUARD_MODE" 2>/dev/null || true)
  if ! echo "$RESULT" | jq -e . >/dev/null 2>&1; then
    unverified "the URL check failed to run, so URLs in this file content cannot be verified."
  else
    CONFIG_ERROR=$(echo "$RESULT" | jq -r '.configError // empty')
    # (not when the file being written IS qa-config.json: that edit is the repair)
    [ -z "$CONFIG_ERROR" ] || [ "$IS_CONFIG_FILE" -eq 1 ] || unverified "$CONFIG_ERROR — its production patterns cannot be applied. Fix qa-config.json."

    SUSPICIOUS=""
    while IFS=$'\t' read -r decision reason url detail; do
      [ -n "$decision" ] || continue
      if [ "$reason" = "PROD_PATTERN" ]; then
        echo "BLOCKED: File content contains a production URL matching pattern: $detail"
        echo "URL: $url"
        echo "Tests and test configuration must never reference production environments."
        echo "Use process.env.BASE_URL or qa-config.json's testEnvironmentBaseUrl instead."
        exit 2
      fi
      SUSPICIOUS="${SUSPICIOUS}${SUSPICIOUS:+ }${url}"
    done < <(echo "$RESULT" | jq -r '.findings[] | [.decision, .reason, .url, (.detail // "")] | @tsv')

    if [ -n "$SUSPICIOUS" ]; then
      if [ "$GUARD_MODE" = "enforce" ] && [ "$IS_DOC_FILE" -eq 0 ]; then
        # Unattended: a warning nobody reads is no guard. Block.
        echo "BLOCKED: File content contains hardcoded URLs that may be production: $SUSPICIOUS"
        echo "Guard mode is 'enforce' (QA_AUTONOMOUS=1 or productionProtection.mode), so anything not recognizably a test environment blocks."
        echo "Use process.env.BASE_URL instead of hardcoding. If a URL is safe, add a regex for it to productionProtection.allowedUrlPatterns in qa-config.json."
        exit 2
      fi
      echo "WARNING: File contains hardcoded URLs that may be production: $SUSPICIOUS"
      echo "Consider using process.env.BASE_URL and configuring productionProtection.prodUrlPatterns in qa-config.json."
    fi
  fi
fi

exit 0

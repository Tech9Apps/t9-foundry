#!/usr/bin/env bash
# PreToolUse hook (Write|Edit) — Layer 4 production safety guard.
# Scans file content being written or edited for production URLs and credentials.
# Exit code 2 surfaces the blocking message to Claude.

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/qa-config-path.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/guard-mode.sh"

INPUT=$(cat)

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

# Resolve qa-config.json independent of cwd (see lib/qa-config-path.sh)
QA_CONFIG_PATH=$(resolve_qa_config || echo "qa-config.json")

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
    echo "" | grep -qE -e "$pattern" 2>/dev/null || grep_rc=$?
    if [ "$grep_rc" -eq 2 ]; then
      echo "WARNING: Skipping invalid production URL pattern: $pattern"
      echo "Fix productionProtection.prodUrlPatterns in qa-config.json to use valid regex."
      continue
    fi
    if echo "$CONTENT" | grep -qE -e "$pattern"; then
      MATCHED_LINE=$(echo "$CONTENT" | grep -nE -e "$pattern" | head -5)
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

# Warn about hardcoded URLs (not configured prod patterns) — don't block, just warn.
# This heuristic always runs as an additional layer, even once prodUrlPatterns
# is configured — a configured list only covers what's been typed in, and
# should not disable the fallback check for everything else.
if [ "$(jq -r 'if .productionProtection.blockOnSuspiciousUrls == false then "false" else "true" end' "$QA_CONFIG_PATH" 2>/dev/null || echo 'true')" = "true" ] \
  && echo "$CONTENT" | grep -qE "https?://[a-z0-9.-]+\.(com|io|net|app|org)"; then
  URLS=$(echo "$CONTENT" | grep -oE "https?://[a-z0-9.-]+\.(com|io|net|app|org)[^'\"[:space:]]*" | head -20 || true)
  if [ -n "$URLS" ]; then
    # Only consider bare non-localhost, non-staging URLs that aren't known-safe hosts
    SUSPICIOUS=""
    while IFS= read -r url; do
      [ -n "$url" ] || continue
      if echo "$url" | grep -qiE "(staging|test|dev|qa|localhost|127\.0\.0\.1|example\.com)"; then continue; fi
      if url_is_exempt "$url" "$QA_CONFIG_PATH"; then continue; fi
      SUSPICIOUS="${SUSPICIOUS}${SUSPICIOUS:+ }${url}"
    done <<< "$URLS"

    if [ -n "$SUSPICIOUS" ]; then
      # Documentation files legitimately link to external sites; never block those.
      case "$FILE_PATH" in
        *.md|*.markdown|*.txt|*.rst) IS_DOC_FILE=1 ;;
        *) IS_DOC_FILE=0 ;;
      esac

      if [ "$(resolve_guard_mode "$QA_CONFIG_PATH")" = "enforce" ] && [ "$IS_DOC_FILE" -eq 0 ]; then
        # Unattended: a warning nobody reads is no guard. Block.
        echo "BLOCKED: File content contains hardcoded URLs that may be production: $SUSPICIOUS"
        echo "Guard mode is 'enforce' (QA_AUTONOMOUS=1 or productionProtection.mode), so heuristic matches block."
        echo "Use process.env.BASE_URL instead of hardcoding. If a URL is safe, add a regex for it to productionProtection.allowedUrlPatterns in qa-config.json."
        exit 2
      fi
      echo "WARNING: File contains hardcoded URLs that may be production: $SUSPICIOUS"
      echo "Consider using process.env.BASE_URL and configuring productionProtection.prodUrlPatterns in qa-config.json."
    fi
  fi
fi

exit 0

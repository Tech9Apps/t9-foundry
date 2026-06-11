#!/usr/bin/env bash
# PreToolUse hook (Write|Edit) — Layer 4 production safety guard.
# Scans file content being written or edited for production URLs and credentials.
# Exit code 2 surfaces the blocking message to Claude.

set -euo pipefail

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

# Load production URL patterns from qa-config.json
PROD_PATTERNS=()
if [ -f "qa-config.json" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && PROD_PATTERNS+=("$line")
  done < <(jq -r '.productionProtection.prodUrlPatterns[]? // empty' qa-config.json 2>/dev/null || true)
fi

# Check against configured production URL patterns
if [ "${#PROD_PATTERNS[@]}" -gt 0 ]; then
  for pattern in "${PROD_PATTERNS[@]}"; do
    if [ -z "$pattern" ]; then continue; fi
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

# Warn about hardcoded URLs (not configured prod patterns) — don't block, just warn
if echo "$CONTENT" | grep -qE "https?://[a-z0-9.-]+\.(com|io|net|app|org)"; then
  URLS=$(echo "$CONTENT" | grep -oE "https?://[a-z0-9.-]+\.(com|io|net|app|org)[^'\"[:space:]]*" | head -5 || true)
  if [ -n "$URLS" ]; then
    # Only block bare non-localhost, non-staging URLs in test files
    SUSPICIOUS=$(echo "$URLS" | grep -vE "(staging|test|dev|qa|localhost|127\.0\.0\.1|example\.com)" || true)
    if [ -n "$SUSPICIOUS" ] && [ ${#PROD_PATTERNS[@]} -eq 0 ]; then
      echo "WARNING: File contains hardcoded URLs that may be production: $SUSPICIOUS"
      echo "Consider using process.env.BASE_URL and configuring productionProtection.prodUrlPatterns in qa-config.json."
    fi
  fi
fi

exit 0

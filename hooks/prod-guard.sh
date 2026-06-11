#!/usr/bin/env bash
# PreToolUse hook (Bash) — Layer 3 production safety guard.
# Blocks any shell command that targets a production environment.
# Exit code 2 surfaces the blocking message to Claude.

set -euo pipefail

INPUT=$(cat)

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Load production URL patterns from qa-config.json if available
PROD_PATTERNS=()
if [ -f "qa-config.json" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && PROD_PATTERNS+=("$line")
  done < <(jq -r '.productionProtection.prodUrlPatterns[]? // empty' qa-config.json 2>/dev/null || true)
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
    echo "Configured test environment: $(jq -r '.environments.testEnvironmentBaseUrl // "not set"' qa-config.json 2>/dev/null || echo 'not set')"
    exit 2
  fi
done

# Check command against configured production URL patterns
if [ "${#PROD_PATTERNS[@]}" -gt 0 ]; then
  for pattern in "${PROD_PATTERNS[@]}"; do
    if [ -z "$pattern" ]; then continue; fi
    if echo "$COMMAND" | grep -qE -e "$pattern"; then
      echo "BLOCKED: Command contains a production URL matching pattern: $pattern"
      echo "Tests must never run against production environments."
      echo "Your configured test environment is: $(jq -r '.environments.testEnvironmentBaseUrl // "not set"' qa-config.json 2>/dev/null || echo 'not set')"
      exit 2
    fi
  done
fi

# Heuristic check: block bare apex domains and prod-named subdomains
# (catches cases where prod patterns haven't been configured yet)
SUSPICIOUS_PATTERNS=(
  "https?://[a-z0-9-]+\.(com|io|app|dev|net|org)/[^[:space:]]"
  "https?://prod\."
  "https?://production\."
  "https?://live\."
  "https?://app\.[a-z0-9-]+\.(com|io|app|net|org)"
)

if [ "$(jq -r '.productionProtection.blockOnSuspiciousUrls // true' qa-config.json 2>/dev/null || echo 'true')" = "true" ]; then
  for pattern in "${SUSPICIOUS_PATTERNS[@]}"; do
    if echo "$COMMAND" | grep -qiE -e "$pattern"; then
      if echo "$COMMAND" | grep -qiE "(staging|test|dev|qa|localhost|127\.0\.0\.1)"; then
        continue
      fi
      # Only warn (not block) on heuristic matches — they may be false positives
      # unless qa-config prodUrlPatterns are not yet configured
      if [ ${#PROD_PATTERNS[@]} -eq 0 ]; then
        echo "WARNING: Command may contain a production URL: $COMMAND"
        echo "Configure productionProtection.prodUrlPatterns in qa-config.json to enable strict blocking."
      fi
      break
    fi
  done
fi

exit 0

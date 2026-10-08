#!/usr/bin/env bash
# PreToolUse hook (Bash) — Layer 3 production safety guard.
# Blocks any shell command that targets a production environment.
# Exit code 2 surfaces the blocking message to Claude.

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/qa-config-path.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/guard-mode.sh"

INPUT=$(cat)

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Resolve qa-config.json independent of cwd (see lib/qa-config-path.sh)
QA_CONFIG_PATH=$(resolve_qa_config || echo "qa-config.json")

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
    echo "" | grep -qE -e "$pattern" 2>/dev/null || grep_rc=$?
    if [ "$grep_rc" -eq 2 ]; then
      echo "WARNING: Skipping invalid production URL pattern: $pattern"
      echo "Fix productionProtection.prodUrlPatterns in qa-config.json to use valid regex."
      continue
    fi
    if echo "$COMMAND" | grep -qE -e "$pattern"; then
      echo "BLOCKED: Command contains a production URL matching pattern: $pattern"
      echo "Tests must never run against production environments."
      echo "Your configured test environment is: $(jq -r '.environments.testEnvironmentBaseUrl // "not set"' "$QA_CONFIG_PATH" 2>/dev/null || echo 'not set')"
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

if [ "$(jq -r 'if .productionProtection.blockOnSuspiciousUrls == false then "false" else "true" end' "$QA_CONFIG_PATH" 2>/dev/null || echo 'true')" = "true" ]; then
  GUARD_MODE=$(resolve_guard_mode "$QA_CONFIG_PATH")

  # Judge each URL on its own — a staging URL elsewhere in the same command
  # must not excuse a production-looking one.
  while IFS= read -r url; do
    [ -n "$url" ] || continue
    if url_is_exempt "$url" "$QA_CONFIG_PATH"; then continue; fi
    if echo "$url" | grep -qiE "(staging|test|dev|qa|localhost|127\.0\.0\.1)"; then continue; fi

    for pattern in "${SUSPICIOUS_PATTERNS[@]}"; do
      if echo "$url" | grep -qiE -e "$pattern"; then
        if [ "$GUARD_MODE" = "enforce" ]; then
          # Unattended: a warning nobody reads is no guard. Block.
          echo "BLOCKED: Command contains a URL that looks like production: $url"
          echo "Guard mode is 'enforce' (QA_AUTONOMOUS=1 or productionProtection.mode), so heuristic matches block."
          echo "If this URL is safe, add a regex for it to productionProtection.allowedUrlPatterns in qa-config.json."
          echo "If it is production, add it to productionProtection.prodUrlPatterns and use your staging URL instead."
          exit 2
        fi
        # warn mode: heuristic matches may be false positives, so only warn.
        # Always warn, even when prodUrlPatterns is configured: a configured
        # pattern list only covers what's been typed in, and this heuristic is
        # meant to layer on top of it, not disable itself once any pattern exists.
        echo "WARNING: Command may contain a production URL: $url"
        echo "Configure productionProtection.prodUrlPatterns in qa-config.json to enable strict blocking."
        break 2
      fi
    done
  done < <(echo "$COMMAND" | extract_urls)
fi

exit 0

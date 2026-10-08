#!/usr/bin/env bash
# SessionStart hook — Layer 2 production safety guard + workspace initialization.
# Validates qa-config.json at session start. Warns if missing or misconfigured.
# Exit code 2 blocks the session if testEnvironmentBaseUrl matches a production pattern.

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/qa-config-path.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/guard-mode.sh"

BOLD='\033[1m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}${BOLD}Tech9 QA Harness${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Resolve qa-config.json independent of cwd (see lib/qa-config-path.sh)
QA_CONFIG_PATH=$(resolve_qa_config || echo "")

# Guard mode: 'enforce' when QA_AUTONOMOUS=1 or productionProtection.mode=enforce.
# Unattended runs fail closed — a warning nobody reads is not a guard.
GUARD_MODE=$(resolve_guard_mode "$QA_CONFIG_PATH")

# Check for qa-config.json
if [ -z "$QA_CONFIG_PATH" ]; then
  if [ "$GUARD_MODE" = "enforce" ]; then
    echo -e "${RED}${BOLD}✗  BLOCKED: qa-config.json not found and guard mode is 'enforce'.${NC}"
    echo "  Autonomous runs require a configured workspace (project, environments, prodUrlPatterns)."
    echo "  Run /init or /switch-project <profile>, then retry."
    exit 2
  fi
  echo -e "${YELLOW}⚠  Workspace not configured.${NC}"
  echo ""
  echo "  Run /init to set up this workspace in one guided step."
  echo ""
  echo "    /init will:"
  echo "      • Ask about your project, stack, and ticket system"
  echo "      • Configure your ticket source and code repository"
  echo "      • Generate security and performance checklists"
  echo ""
  echo "  (Or run /connect-tickets then /connect-repo manually.)"
  echo ""
  exit 0
fi

# Check for jq dependency
if ! command -v jq &>/dev/null; then
  echo -e "${RED}✗  ERROR: jq is required but not installed.${NC}"
  echo "  Install it: brew install jq"
  exit 2
fi

# A malformed config must not silently disable the guards.
if ! jq -e . "$QA_CONFIG_PATH" >/dev/null 2>&1; then
  echo -e "${RED}${BOLD}✗  BLOCKED: $QA_CONFIG_PATH is not valid JSON.${NC}"
  echo "  Fix the syntax error (run: jq . $QA_CONFIG_PATH) and restart the session."
  exit 2
fi

# Guard mode may be set by the config itself; re-resolve now that it is known to parse.
GUARD_MODE=$(resolve_guard_mode "$QA_CONFIG_PATH")

# Read config values
PROJECT_NAME=$(jq -r '.project.name // "Unnamed Project"' "$QA_CONFIG_PATH")
TICKET_SOURCE=$(jq -r '.ticketSource.type // "not configured"' "$QA_CONFIG_PATH")
REPO_TYPE=$(jq -r '.codeRepository.type // "not configured"' "$QA_CONFIG_PATH")
TEST_ENV_URL=$(jq -r '.environments.testEnvironmentBaseUrl // ""' "$QA_CONFIG_PATH")
TEST_FRAMEWORK=$(jq -r '.testFramework.type // "not configured"' "$QA_CONFIG_PATH")

echo -e "Project: ${BOLD}$PROJECT_NAME${NC}"
echo ""

# Validate testEnvironmentBaseUrl against production patterns
PROD_PATTERNS=()
while IFS= read -r line; do
  [ -n "$line" ] && PROD_PATTERNS+=("$line")
done < <(jq -r '.productionProtection.prodUrlPatterns[]? // empty' "$QA_CONFIG_PATH" 2>/dev/null || true)

# Enforce mode: no patterns / no staging URL means no way to prove the target is safe.
if [ "$GUARD_MODE" = "enforce" ]; then
  if [ "${#PROD_PATTERNS[@]}" -eq 0 ]; then
    echo -e "${RED}${BOLD}✗  BLOCKED: productionProtection.prodUrlPatterns is empty and guard mode is 'enforce'.${NC}"
    echo "  Unattended runs must have production URL patterns configured. Add them with /reconfigure."
    exit 2
  fi
  if [ -z "$TEST_ENV_URL" ]; then
    echo -e "${RED}${BOLD}✗  BLOCKED: environments.testEnvironmentBaseUrl is not set and guard mode is 'enforce'.${NC}"
    echo "  Set your staging URL with /reconfigure."
    exit 2
  fi
fi

# Warn if no production URL patterns are configured (blocking is disabled)
if [ "${#PROD_PATTERNS[@]}" -eq 0 ]; then
  echo -e "${YELLOW}⚠  productionProtection.prodUrlPatterns is empty — production URL blocking is disabled.${NC}"
  echo "  Add patterns with /reconfigure to enable strict URL blocking."
  echo ""
fi

if [ -n "$TEST_ENV_URL" ] && [ ${#PROD_PATTERNS[@]} -gt 0 ]; then
  for pattern in "${PROD_PATTERNS[@]}"; do
    if [ -z "$pattern" ]; then continue; fi
    if echo "$TEST_ENV_URL" | grep -qE -e "$pattern"; then
      echo -e "${RED}${BOLD}✗  CRITICAL: testEnvironmentBaseUrl matches a production pattern!${NC}"
      echo ""
      echo "  Configured URL:  $TEST_ENV_URL"
      echo "  Matched pattern: $pattern"
      echo ""
      echo "  Your qa-config.json is pointing at PRODUCTION. Tests must never run against production."
      echo "  Fix qa-config.json > environments.testEnvironmentBaseUrl to use your staging environment."
      echo ""
      exit 2
    fi
  done
fi

# Check for Azure DevOps PAT if configured
if [ "$TICKET_SOURCE" = "azure" ]; then
  if [ -z "${AZURE_DEVOPS_PAT:-}" ]; then
    echo -e "${YELLOW}⚠  AZURE_DEVOPS_PAT is not set.${NC}"
    echo "  Add to your shell profile: export AZURE_DEVOPS_PAT=your_personal_access_token"
  fi
fi

# Check for ClickUp token if configured
if [ "$TICKET_SOURCE" = "clickup" ]; then
  if [ -z "${CLICKUP_TOKEN:-}" ]; then
    echo -e "${YELLOW}⚠  CLICKUP_TOKEN is not set.${NC}"
    echo "  Add to your shell profile: export CLICKUP_TOKEN=your_token"
  fi
fi

# Check for GitLab token if configured
if [ "$TICKET_SOURCE" = "gitlab" ] || [ "$REPO_TYPE" = "gitlab" ]; then
  if [ -z "${GITLAB_TOKEN:-}" ]; then
    echo -e "${YELLOW}⚠  GITLAB_TOKEN is not set.${NC}"
    echo "  Add to your shell profile: export GITLAB_TOKEN=your_personal_access_token"
  fi
fi

# Check for Bitbucket token if configured
if [ "$TICKET_SOURCE" = "bitbucket" ] || [ "$REPO_TYPE" = "bitbucket" ]; then
  if [ -z "${BITBUCKET_TOKEN:-}" ]; then
    echo -e "${YELLOW}⚠  BITBUCKET_TOKEN is not set.${NC}"
    echo "  Add to your shell profile: export BITBUCKET_TOKEN=your_app_password"
  fi
  if [ "$TICKET_SOURCE" = "bitbucket" ] && [ -z "$(jq -r '.ticketSource.bitbucket.username // empty' "$QA_CONFIG_PATH")" ]; then
    echo -e "${YELLOW}⚠  ticketSource.bitbucket.username is not set.${NC}"
    echo "  Bitbucket app passwords authenticate as username:app_password — set it with /reconfigure."
  fi
fi

# Display workspace summary
echo -e "  ${GREEN}✓${NC} Ticket source:    $TICKET_SOURCE"
echo -e "  ${GREEN}✓${NC} Code repository:  $REPO_TYPE"
if [ -n "$TEST_ENV_URL" ]; then
  echo -e "  ${GREEN}✓${NC} Test environment: $TEST_ENV_URL"
else
  echo -e "  ${YELLOW}⚠${NC} Test environment: not configured — run /connect-repo"
fi
echo -e "  ${GREEN}✓${NC} E2e framework:    $TEST_FRAMEWORK"
echo -e "  ${GREEN}✓${NC} Guard mode:       $GUARD_MODE"
echo ""
echo -e "  Skills: /create-test-plan  /write-test-cases  /upload-tests  /write-e2e-tests"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

exit 0

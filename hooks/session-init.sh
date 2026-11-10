#!/usr/bin/env bash
# SessionStart hook — Layer 2 production safety notice + workspace initialization.
# Validates qa-config.json at session start and TELLS the user if it is missing, malformed or unsafe.
#
# It cannot stop anything: Claude Code does not block a session when a SessionStart hook fails. Exit 2 here only shows the user the stderr text
# as a notice ("Exit code 2 behavior per event" in https://code.claude.com/docs/en/hooks) and the session carries on. What actually stops an
# unsafe run is hooks/prod-guard.sh (PreToolUse, where exit 2 does block): it refuses every shell command while the same problems exist,
# and both hooks ask hooks/lib/url-guard.js, so they cannot disagree. Messages go to stderr because that is the only channel shown.

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/qa-config-path.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/guard-mode.sh"
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BOLD='\033[1m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

# Tell the user the workspace is not safe to run, then exit 2 (a notice; see the header). <message> [detail line...]
unsafe() {
  local message="$1" line; shift
  echo -e "${RED}${BOLD}✗  NOT SAFE TO RUN: $message${NC}" >&2
  for line in "$@"; do echo "  $line" >&2; done
  echo "  (This is a notice: Claude Code lets the session continue. Until it is fixed, hooks/prod-guard.sh refuses every shell command.)" >&2
  exit 2
}

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
    unsafe "qa-config.json not found and guard mode is 'enforce'." \
      "Autonomous runs require a configured workspace (project, environments, prodUrlPatterns)." \
      "Run /init or /switch-project <profile>, then retry."
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
  unsafe "jq is required but not installed." "Install it: brew install jq"
fi

# A malformed config must not silently disable the guards.
if ! jq -e . "$QA_CONFIG_PATH" >/dev/null 2>&1; then
  unsafe "$QA_CONFIG_PATH is not valid JSON." "Fix the syntax error (run: jq . $QA_CONFIG_PATH) and restart the session."
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

# Problems with the configuration itself, asked of the same reader prod-guard.sh uses: in enforce mode no production patterns or no staging
# URL (nothing then proves a target is safe); in any mode a staging URL that is itself a production URL, in any spelling.
NODE_BIN=$(command -v node || true)
if [ -n "$NODE_BIN" ]; then
  PROBLEMS=$("$NODE_BIN" "$HOOK_DIR/lib/url-guard.js" --config "$QA_CONFIG_PATH" --mode "$GUARD_MODE" </dev/null 2>/dev/null | jq -r '.configProblems[]? | "\(.code)\t\(.message)"' 2>/dev/null || true)
  if [ -n "$PROBLEMS" ]; then
    while IFS=$'\t' read -r code message; do
      if [ "$code" = "TEST_ENV_IS_PROD" ]; then
        echo -e "${RED}${BOLD}✗  CRITICAL: $message${NC}" >&2
        echo "  Fix qa-config.json > environments.testEnvironmentBaseUrl to use your staging environment." >&2
      else
        echo -e "${RED}${BOLD}✗  NOT SAFE TO RUN: $message${NC}" >&2
        echo "  Fix it with /reconfigure." >&2
      fi
    done <<< "$PROBLEMS"
    echo "  (This is a notice: Claude Code lets the session continue. Until it is fixed, hooks/prod-guard.sh refuses every shell command.)" >&2
    exit 2
  fi
else
  echo -e "${YELLOW}⚠  node is not installed, so qa-config.json cannot be checked for a staging URL that is really production.${NC}"
fi

# Warn if no production URL patterns are configured (blocking is disabled)
if [ "${#PROD_PATTERNS[@]}" -eq 0 ]; then
  echo -e "${YELLOW}⚠  productionProtection.prodUrlPatterns is empty — production URL blocking is disabled.${NC}"
  echo "  Add patterns with /reconfigure to enable strict URL blocking."
  echo ""
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

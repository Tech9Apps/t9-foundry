#!/usr/bin/env bash
# Verifies that all required tools are installed for the QA harness.

set -euo pipefail

PASS=0
WARN=0
FAIL=0

check() {
  local name="$1"
  local cmd="$2"
  local install_hint="$3"
  local required="${4:-true}"

  if eval "$cmd" &>/dev/null; then
    echo "  ✓  $name"
    ((PASS++)) || true
  else
    if [ "$required" = "true" ]; then
      echo "  ✗  $name — NOT FOUND"
      echo "     Install: $install_hint"
      ((FAIL++)) || true
    else
      echo "  ⚠  $name — not found (optional)"
      echo "     Install: $install_hint"
      ((WARN++)) || true
    fi
  fi
}

echo ""
echo "Tech9 QA Harness — Prerequisites Check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Required:"
check "Claude Code CLI"  "claude --version"                            "https://claude.ai/code"
check "jq"               "jq --version"                                "brew install jq"
echo ""
echo "Required for GitHub / GitHub Issues:"
check "GitHub CLI (gh)"      "gh --version"    "brew install gh  &&  gh auth login"  "false"
check "gh CLI authenticated"  "gh auth status"  "gh auth login"                       "false"
echo ""
echo "Optional — set in your shell profile if using these sources:"
check "AZURE_DEVOPS_PAT env var" "[ -n \"\${AZURE_DEVOPS_PAT:-}\" ]"   "export AZURE_DEVOPS_PAT=your_personal_access_token" "false"
check "CLICKUP_TOKEN env var"    "[ -n \"\${CLICKUP_TOKEN:-}\" ]"      "export CLICKUP_TOKEN=your_api_token"          "false"
check "GITLAB_TOKEN env var"     "[ -n \"\${GITLAB_TOKEN:-}\" ]"       "export GITLAB_TOKEN=your_personal_access_token" "false"
check "BITBUCKET_TOKEN env var"  "[ -n \"\${BITBUCKET_TOKEN:-}\" ]"    "export BITBUCKET_TOKEN=your_app_password"      "false"
echo ""
echo "Required for e2e frameworks (install in your app repo, not here):"
check "Node.js"  "node --version"   "https://nodejs.org  or:  brew install node"   "false"
check "npm"      "npm --version"    "bundled with Node.js"                           "false"
echo ""
echo "Optional — e2e frameworks (install in your app repo):"
check "Playwright (npx)"  "npx playwright --version"  "npm install -D @playwright/test  (in your app repo)"  "false"
check "Cypress (npx)"     "npx cypress --version"     "npm install -D cypress  (in your app repo)"           "false"
echo ""
echo "Optional — for pytest-based projects:"
check "Python 3"  "python3 --version || python --version"  "https://python.org  or:  brew install python3"  "false"
echo ""
echo "Optional — for snapshot/restore data strategy:"
check "Docker"  "docker --version"  "https://docker.com/get-started"  "false"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $FAIL required tool(s) missing. Install them before using the harness."
  echo ""
  exit 1
else
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  All required tools present. $WARN optional tool(s) not configured."
  echo "  Open this workspace with: claude"
  echo ""
fi

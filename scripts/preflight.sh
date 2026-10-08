#!/usr/bin/env bash
# Preflight for autonomous (unattended) QA runs.
#
# Verifies — before anything is generated, posted, or executed — that the workspace
# is configured safely enough to run with nobody watching. Exit 0 = go, 1 = no-go.
#
# Usage: scripts/preflight.sh [--skip-network] [--config <path>]
#   --skip-network   skip the staging reachability check and `gh auth status`
#   --config <path>  check this config file instead of resolving qa-config.json
#
# bash 3.2 compatible (macOS default shell).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$REPO_ROOT/hooks/lib/qa-config-path.sh"
source "$REPO_ROOT/hooks/lib/guard-mode.sh"

SKIP_NETWORK=0
CONFIG_OVERRIDE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-network) SKIP_NETWORK=1 ;;
    --config) shift; CONFIG_OVERRIDE="${1:-}" ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

FAIL=0
WARN=0
ok()   { echo "  ✓  $1"; }
warn() { echo "  ⚠  $1"; [ -n "${2:-}" ] && echo "       $2"; WARN=$((WARN + 1)); }
fail() { echo "  ✗  $1"; [ -n "${2:-}" ] && echo "       Fix: $2"; FAIL=$((FAIL + 1)); }

echo ""
echo "Tech9 QA Harness — Preflight"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Tooling ──────────────────────────────────────────────────────────────────
if command -v jq >/dev/null 2>&1; then
  ok "jq installed"
else
  fail "jq not installed" "brew install jq"
  echo ""; echo "  Cannot continue without jq."; exit 1
fi

# ── Config ───────────────────────────────────────────────────────────────────
cd "$REPO_ROOT" || exit 1
if [ -n "$CONFIG_OVERRIDE" ]; then
  CFG="$CONFIG_OVERRIDE"
  [ -f "$CFG" ] || CFG=""
else
  CFG=$(resolve_qa_config || echo "")
fi
if [ -z "$CFG" ]; then
  fail "qa-config.json not found" "run /init or /switch-project <profile>"
  echo ""; echo "  Cannot continue without a config."; exit 1
fi
if ! jq -e . "$CFG" >/dev/null 2>&1; then
  fail "$CFG is not valid JSON" "run: jq . $CFG"
  echo ""; echo "  Cannot continue with a malformed config."; exit 1
fi
ok "qa-config.json found and parses ($CFG)"

for key in project ticketSource codeRepository environments productionProtection; do
  if [ "$(jq -r --arg k "$key" 'has($k)' "$CFG")" != "true" ]; then
    fail "required config section missing: $key" "run /init or /reconfigure"
  fi
done

MODE=$(resolve_guard_mode "$CFG")
if [ "${QA_AUTONOMOUS:-}" = "1" ]; then
  ok "autonomous run (QA_AUTONOMOUS=1) — guard mode: $MODE"
else
  warn "QA_AUTONOMOUS is not set — guard mode: $MODE" "autonomous entry points set QA_AUTONOMOUS=1; running preflight by hand checks the config only"
fi

if [ "$(jq -r 'if .productionProtection.blockOnSuspiciousUrls == false then "off" else "on" end' "$CFG")" = "off" ] && [ "$MODE" = "enforce" ]; then
  warn "blockOnSuspiciousUrls is false — the suspicious-URL heuristic is disabled" "unattended runs then rely entirely on prodUrlPatterns being complete"
fi

# ── Production protection ────────────────────────────────────────────────────
STAGING_URL=$(jq -r '.environments.testEnvironmentBaseUrl // ""' "$CFG")
PATTERNS=()
while IFS= read -r line; do
  [ -n "$line" ] && PATTERNS+=("$line")
done < <(jq -r '.productionProtection.prodUrlPatterns[]? // empty' "$CFG")

if [ -z "$STAGING_URL" ]; then
  fail "environments.testEnvironmentBaseUrl is not set" "run /reconfigure"
else
  ok "staging URL: $STAGING_URL"
fi

if [ "${#PATTERNS[@]}" -eq 0 ]; then
  fail "productionProtection.prodUrlPatterns is empty" "add your production URL regexes with /reconfigure"
else
  ok "${#PATTERNS[@]} production URL pattern(s) configured"
  for p in "${PATTERNS[@]}"; do
    rc=0
    echo "" | grep -qE -e "$p" 2>/dev/null || rc=$?
    if [ "$rc" -eq 2 ]; then
      fail "invalid production URL regex: $p" "fix productionProtection.prodUrlPatterns"
    elif [ -n "$STAGING_URL" ] && echo "$STAGING_URL" | grep -qE -e "$p"; then
      fail "staging URL matches production pattern: $p" "your config points at production — fix environments.testEnvironmentBaseUrl"
    fi
  done
fi

# ── Ticket source credentials ────────────────────────────────────────────────
TYPE=$(jq -r '.ticketSource.type // "none"' "$CFG")
check_token() { # <default-env-var>
  local var
  var=$(jq -r --arg t "$TYPE" --arg d "$1" '.ticketSource[$t].tokenEnvVar // $d' "$CFG")
  if [ -n "${!var:-}" ]; then ok "$var is set"; else fail "$var is not set" "export $var=<token> in your shell profile or CI secrets"; fi
}
case "$TYPE" in
  azure|clickup|gitlab|bitbucket)
    case "$TYPE" in
      azure)     check_token AZURE_DEVOPS_PAT ;;
      clickup)   check_token CLICKUP_TOKEN ;;
      gitlab)    check_token GITLAB_TOKEN ;;
      bitbucket) check_token BITBUCKET_TOKEN
                 if [ -z "$(jq -r '.ticketSource.bitbucket.username // empty' "$CFG")" ]; then
                   fail "ticketSource.bitbucket.username is not set" "Bitbucket app passwords need username:app_password — run /reconfigure"
                 fi ;;
    esac ;;
  github)
    if [ "$SKIP_NETWORK" -eq 1 ]; then warn "gh auth not checked (--skip-network)"
    elif command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then ok "gh CLI authenticated"
    else fail "gh CLI is not authenticated" "gh auth login (or set GH_TOKEN in CI)"; fi ;;
  jira)
    if [ "${QA_AUTONOMOUS:-}" = "1" ]; then
      warn "Jira is accessed through the Atlassian MCP connector, which needs an interactive login" "headless Jira needs the REST adapter (v2 Phase 1); until then run Jira projects interactively"
    else
      ok "Jira via Atlassian MCP (interactive)"
    fi ;;
  none) ok "no ticket system configured" ;;
  *)    warn "unrecognized ticketSource.type: $TYPE" ;;
esac

# ── App repo: Layer 5 can find this config ───────────────────────────────────
LOCAL_PATH=$(jq -r '.codeRepository.localPath // ""' "$CFG")
if [ -n "$LOCAL_PATH" ]; then
  case "$LOCAL_PATH" in /*|~*) APP_DIR="${LOCAL_PATH/#\~/$HOME}" ;; *) APP_DIR="$REPO_ROOT/$LOCAL_PATH" ;; esac
  if [ -d "$APP_DIR" ]; then
    APP_DIR="$(cd "$APP_DIR" && pwd)"
    ok "app repo found: $APP_DIR"
    if [ -f "$APP_DIR/.env.test" ]; then
      HARNESS_LINE=$(grep -E '^QA_HARNESS_DIR=' "$APP_DIR/.env.test" | tail -1 | cut -d= -f2- || true)
      if [ -z "$HARNESS_LINE" ]; then
        fail ".env.test has no QA_HARNESS_DIR" "add QA_HARNESS_DIR=$REPO_ROOT so the Layer 5 runtime guard can find qa-config.json"
      elif [ ! -f "$HARNESS_LINE/qa-config.json" ]; then
        fail ".env.test QA_HARNESS_DIR does not contain qa-config.json ($HARNESS_LINE)" "set QA_HARNESS_DIR=$REPO_ROOT"
      else
        ok "app repo .env.test QA_HARNESS_DIR resolves to this harness"
      fi
    else
      warn "no .env.test in the app repo" "copy .env.test.example to .env.test and fill it in before running tests"
    fi
  else
    fail "codeRepository.localPath does not exist: $APP_DIR" "run /connect-repo"
  fi
else
  warn "codeRepository.localPath is not set" "code analysis and test execution need a local app repo"
fi

# ── Staging reachability ─────────────────────────────────────────────────────
if [ -n "$STAGING_URL" ]; then
  if [ "$SKIP_NETWORK" -eq 1 ]; then
    warn "staging reachability not checked (--skip-network)"
  else
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$STAGING_URL" 2>/dev/null || echo "000")
    case "$CODE" in
      000) fail "staging URL is unreachable: $STAGING_URL" "check the URL, VPN, and that staging is up" ;;
      5*)  fail "staging URL returned HTTP $CODE: $STAGING_URL" "staging looks unhealthy — an environment failure, not a test failure" ;;
      *)   ok "staging URL reachable (HTTP $CODE)" ;;
    esac
  fi
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAIL" -gt 0 ]; then
  echo "  NO-GO: $FAIL blocking issue(s), $WARN warning(s)."
  echo ""
  exit 1
fi
echo "  GO: no blocking issues ($WARN warning(s))."
echo ""
exit 0

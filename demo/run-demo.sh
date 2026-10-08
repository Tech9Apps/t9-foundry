#!/usr/bin/env bash
# The 2-minute tour: no install, no AI, no network, nothing in your tree is modified.
#
#   bash demo/run-demo.sh                    # paced — press Enter between acts
#   bash demo/run-demo.sh --no-pause         # straight through (also automatic when not a terminal)
#   bash demo/run-demo.sh --tracker [name]   # add Act 8: post everything to an in-memory tracker
#                                            #   (github | clickup | azure | gitlab | bitbucket; default github)
#
# What it shows (all real — the same hooks, scripts and tests the harness uses):
#   1. a ticket and the acceptance criteria a tester starts from
#   2. the test cases the harness derives from it
#   3. automated checks run against a real app  -> they find 2 bugs
#   4. how a failure is triaged into a bug report
#   5. the production-safety guards actually blocking commands
#   6. the preflight gate for unattended runs
#   7. the fixes applied (in a scratch copy) -> green
#
# Needs: bash, node >= 20, jq, patch.   Exit 0 = the tour behaved as documented.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="$HERE/app"
EXPECTED_FAILS="DEMO-101/TC-005 DEMO-102/TC-006"

PAUSE=1
TRACKER=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-pause|--ci) PAUSE=0 ;;
    --tracker)
      TRACKER="github"
      case "${2:-}" in github|clickup|azure|gitlab|bitbucket) TRACKER="$2"; shift ;; esac ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -t 0 ] || PAUSE=0

if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; N=$'\033[0m'
else B=""; D=""; R=""; G=""; Y=""; C=""; N=""; fi

PROBLEMS=0
problem() { echo "${R}✗ DEMO INTEGRITY: $1${N}"; PROBLEMS=$((PROBLEMS + 1)); }

act() { # <number> <title>
  echo ""
  echo "${C}${B}━━ Act $1 — $2 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
}
say() { echo "   $*"; }
pause() {
  if [ "$PAUSE" -eq 1 ]; then printf '\n%s   ⏎  press Enter to continue…%s' "$D" "$N"; read -r _; fi
}

for tool in node jq patch; do
  command -v "$tool" >/dev/null 2>&1 || { echo "✗ '$tool' is required but not installed." >&2; exit 1; }
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/qa-demo.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "${B}Tech9 QA Harness — the 2-minute tour${N}"
echo "${D}Project: Brew & Co, a tiny coffee-shop checkout. Local only; nothing leaves this machine.${N}"

# ── Act 1 ─────────────────────────────────────────────────────────────────────
act 1 "A ticket lands"
say "Product hands QA a story. This is DEMO-101 — the acceptance criteria are where every test starts:"
echo ""
say "${B}Acceptance criteria${N}"
sed -n '/^### Acceptance Criteria/,/^## Technical Notes/p' "$HERE/tickets/DEMO-101.md" | sed '1,2d;$d' | sed 's/\*\*//g; s/^/   /'
say "${D}(There are two more tickets: DEMO-102 pricing, DEMO-103 sign-in lockout.)${N}"
pause

# ── Act 2 ─────────────────────────────────────────────────────────────────────
act 2 "The harness turns it into test cases"
say "From the ticket + the app's source code, /write-test-cases produces traceable cases. For DEMO-101:"
echo ""
grep -E '^### TC-' "$HERE/expected/DEMO-101-test-cases.md" | sed 's/^### /   • /'
TC_TOTAL=$(cat "$HERE"/expected/DEMO-10*-test-cases.md | grep -c '^### TC-')
say ""
say "${D}Across all three tickets: ${TC_TOTAL} cases, each tied to an acceptance criterion. Full text: demo/expected/${N}"
pause

# ── Act 3 ─────────────────────────────────────────────────────────────────────
act 3 "Run the automated checks against the app"
say "Most of the cases are automated as plain Node API checks (no browser, no install; the few UI-only"
say "cases stay manual). Running ${B}cd demo/app && npm test${N}:"
echo ""
TAP="$TMP/tap.txt"
( cd "$APP" && node --test --test-reporter=tap >"$TAP" 2>&1 )
PASS=0; FAIL=0; FAILED_NAMES=""
# "status|DEMO-101/TC-005: title", sorted by ticket then case (node runs files concurrently)
RESULTS=$(grep -E '^\s*(not ok|ok) [0-9]+ - DEMO-' "$TAP" | sed -E 's/^[[:space:]]*(not ok|ok) [0-9]+ - /\1|/' | sort -t'|' -k2,2)
while IFS='|' read -r status full; do
  [ -n "$full" ] || continue
  if [ "$status" = "not ok" ]; then
    name=${full%%:*}
    echo "   ${R}✗${N} $full"; FAIL=$((FAIL + 1)); FAILED_NAMES="$FAILED_NAMES $name"
  else
    echo "   ${G}✓${N} ${D}$full${N}"; PASS=$((PASS + 1))
  fi
done <<< "$RESULTS"
echo ""
say "${B}${PASS} passed, ${FAIL} failed.${N} Two checks caught real bugs in the app."
FAILED_NAMES="${FAILED_NAMES# }"
[ "$FAILED_NAMES" = "$EXPECTED_FAILS" ] || problem "expected failures [$EXPECTED_FAILS] but got [$FAILED_NAMES]"
pause

# ── Act 4 ─────────────────────────────────────────────────────────────────────
act 4 "Triage: from a red test to a bug a developer can act on"
say "A failure only matters once someone knows why. For each one the harness checks: is the test right? is it"
say "flaky? is it the environment? Both of these are deterministic product bugs — so /file-bug writes them up:"
for id in $FAILED_NAMES; do
  ticket="${id%%/*}"
  report=$(ls "$HERE"/expected/bug-"$ticket"-*.md 2>/dev/null | head -1)
  [ -n "$report" ] || { problem "no sample bug report for $ticket"; continue; }
  echo ""
  echo "   ${B}$(head -1 "$report" | sed 's/^# //')${N}"
  sed -n '/^| | Expected | Actual |/,/^$/p' "$report" | sed 's/^/     /'
  say "${D}Severity: $(grep -A1 '^## Severity' "$report" | tail -1 | sed 's/\*\*//g;s/ — .*//')   Full report: demo/expected/$(basename "$report")${N}"
done
pause

# ── Act 5 ─────────────────────────────────────────────────────────────────────
act 5 "Safety: tests must never touch production"
say "Five independent layers guard this. Here are the real command guards, run against the demo's config"
say "(production = brewandco.com). First, a command aimed at production:"
mkdir -p "$TMP/project"
cp "$HERE/qa-config.demo.json" "$TMP/project/qa-config.json"
guard() { # <command-string> [ENV=VAL]  -> prints hook output, sets GUARD_RC
  local json out
  json=$(jq -n --arg c "$1" '{"tool_input":{"command":$c}}')
  out=$(env CLAUDE_PROJECT_DIR="$TMP/project" ${2:+"$2"} bash "$ROOT/hooks/prod-guard.sh" <<<"$json" 2>&1); GUARD_RC=$?
  [ -z "$out" ] || echo "$out" | sed 's/^/     /'
}
echo ""
say "${B}\$ curl https://shop.brewandco.com/api/checkout${N}"
guard "curl -s https://shop.brewandco.com/api/checkout"
[ "$GUARD_RC" -eq 2 ] && say "${R}→ BLOCKED (exit 2)${N}" || problem "production URL was not blocked (rc=$GUARD_RC)"
echo ""
say "…and the same guard letting the local test environment through:"
say "${B}\$ curl http://localhost:4173/api/products${N}"
guard "curl -s http://localhost:4173/api/products"
[ "$GUARD_RC" -eq 0 ] && say "${G}→ allowed (exit 0)${N}" || problem "localhost was blocked (rc=$GUARD_RC)"
echo ""
say "Unattended runs fail closed. With QA_AUTONOMOUS=1 even a URL that merely ${B}looks${N} like production blocks"
say "(interactively it would only warn — nobody is there to read a warning at 3am):"
say "${B}\$ QA_AUTONOMOUS=1 curl https://otherapp.io/dashboard${N}"
guard "curl -s https://otherapp.io/dashboard" "QA_AUTONOMOUS=1"
[ "$GUARD_RC" -eq 2 ] && say "${R}→ BLOCKED (exit 2)${N}" || problem "enforce mode did not block (rc=$GUARD_RC)"
pause

# ── Act 6 ─────────────────────────────────────────────────────────────────────
act 6 "Preflight: a go/no-go before anything runs unattended"
say "${B}\$ QA_AUTONOMOUS=1 scripts/preflight.sh${N}   ${D}(checks the demo config; no network)${N}"
echo ""
env QA_AUTONOMOUS=1 bash "$ROOT/scripts/preflight.sh" --skip-network --config "$HERE/qa-config.demo.json" 2>&1 | sed 's/^/   /'
[ "${PIPESTATUS[0]}" -eq 0 ] || problem "preflight reported NO-GO for the demo config"
pause

# ── Act 7 ─────────────────────────────────────────────────────────────────────
act 7 "Fix the bugs, prove it"
say "The two fixes are one line each. Applying them to a scratch copy of the app (your files are untouched):"
cp -R "$APP" "$TMP/app-fixed"
if patch -p1 -d "$TMP/app-fixed" --silent < "$HERE/fixes.patch"; then
  grep -E '^[-+] ' "$HERE/fixes.patch" | sed 's/^/     /'
  echo ""
  RESULT=$( cd "$TMP/app-fixed" && node --test --test-reporter=tap 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' ' )
  say "Re-running the same checks → ${B}${RESULT}${N}"
  echo "$RESULT" | grep -q '# fail 0' && say "${G}✓ Green.${N} Those two checks are now regression tests that guard the fix." || problem "fixed app still has failures"
else
  problem "fixes.patch did not apply"
fi
pause

# ── Act 8 (opt-in) ────────────────────────────────────────────────────────────
if [ -n "$TRACKER" ]; then
  say ""
  say "${D}Connecting to an in-memory tracker (no network): the real adapter CLI, schemas and idempotency logic.${N}"
  node "$HERE/tracker-demo.js" --embedded --tracker "$TRACKER"
  rc=$?
  [ "$rc" -eq 0 ] || problem "the tracker demo reported a problem (exit $rc)"
  pause
fi

# ── Wrap ──────────────────────────────────────────────────────────────────────
echo ""
echo "${C}${B}━━ What you just saw ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
say "ticket → test cases → automated run → triage → bug report, with production safety enforced throughout."
say "Done by hand, that is a lot of reading, writing, running and write-up. The harness does the legwork;"
say "people keep the judgment calls (is this release-blocking? is the requirement itself right?)."
echo ""
[ -n "$TRACKER" ] || say "${B}See it post to a tracker${N}:  bash demo/run-demo.sh --tracker   ${D}(github | clickup | azure | gitlab | bitbucket)${N}"
say "${B}Try it for real${N} (about 15 minutes, needs Claude Code):  open this repo in Claude Code and run  ${B}/demo${N}"
say "${B}Read more${N}: demo/README.md  ·  sample outputs: demo/expected/  ·  the app: demo/app/"
echo ""

if [ "$PROBLEMS" -gt 0 ]; then
  echo "${R}The tour found $PROBLEMS integrity problem(s) — the demo no longer behaves as documented.${N}"
  exit 1
fi
exit 0

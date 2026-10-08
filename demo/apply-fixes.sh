#!/usr/bin/env bash
# Spoiler! Applies (or reverts) the two one-line fixes for the demo app's planted bugs,
# so you can watch the suite go from red to green after the harness has found them.
#
#   bash demo/apply-fixes.sh            # fix the app  -> npm test is green
#   bash demo/apply-fixes.sh --revert   # re-break it  -> back to 2 failures
#
# QA_DEMO_APP overrides the app directory (used by the tests; you never need it).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${QA_DEMO_APP:-$HERE/app}"
PATCH="$HERE/fixes.patch"

# `patch -N` skips hunks that look already applied instead of prompting (BSD/macOS patch would
# otherwise quietly answer its "Ignore -R?" prompt). A forward dry-run that succeeds therefore
# means "the fixes are NOT applied yet".
fixes_not_applied() { patch -N -p1 -d "$APP" --dry-run --silent < "$PATCH" >/dev/null 2>&1; }

case "${1:-}" in
  --revert)
    if fixes_not_applied; then
      echo "• The bugs are already in place — nothing to revert."
    else
      patch -R -p1 -d "$APP" --silent < "$PATCH"
      echo "✓ Bugs restored (2 checks fail again)."
    fi
    ;;
  "")
    if fixes_not_applied; then
      patch -N -p1 -d "$APP" --silent < "$PATCH"
      echo "✓ Fixes applied. Run: cd demo/app && npm test"
    else
      echo "• Fixes are already applied (or the files were edited by hand) — nothing changed."
    fi
    ;;
  *)
    echo "Usage: apply-fixes.sh [--revert]" >&2; exit 2 ;;
esac

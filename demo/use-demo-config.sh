#!/usr/bin/env bash
# Make the demo project the active workspace config WITHOUT losing your real one.
#
#   bash demo/use-demo-config.sh      # back up qa-config.json (if any), install the demo config
#   bash demo/restore-demo-config.sh  # undo: put your original config back
#
# QA_DEMO_ROOT overrides the harness root (used by the tests; you never need it).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${QA_DEMO_ROOT:-$(cd "$HERE/.." && pwd)}"
CONFIG="$ROOT/qa-config.json"
BACKUP="$ROOT/qa-config.json.backup-before-demo"
DEMO="$HERE/qa-config.demo.json"

if [ -f "$CONFIG" ] && cmp -s "$CONFIG" "$DEMO"; then
  echo "Demo config is already active."
  mkdir -p "$ROOT/demo/output"
  exit 0
fi

if [ -f "$CONFIG" ]; then
  if [ -e "$BACKUP" ]; then
    echo "✗ A backup already exists at $BACKUP" >&2
    echo "  Refusing to overwrite it (it may hold your only copy of a real config)." >&2
    echo "  Run 'bash demo/restore-demo-config.sh' first, or move the backup aside." >&2
    exit 1
  fi
  cp "$CONFIG" "$BACKUP"
  echo "• Backed up your config to qa-config.json.backup-before-demo"
fi

cp "$DEMO" "$CONFIG"
mkdir -p "$ROOT/demo/output"
echo "✓ Demo config active (project: Brew & Co). Generated files go to demo/output/."
echo "  Undo any time with: bash demo/restore-demo-config.sh"

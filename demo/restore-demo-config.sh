#!/usr/bin/env bash
# Undo use-demo-config.sh: restore your original qa-config.json (or remove the demo one).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${QA_DEMO_ROOT:-$(cd "$HERE/.." && pwd)}"
CONFIG="$ROOT/qa-config.json"
BACKUP="$ROOT/qa-config.json.backup-before-demo"
DEMO="$HERE/qa-config.demo.json"

if [ -e "$BACKUP" ]; then
  mv "$BACKUP" "$CONFIG"
  echo "✓ Restored your original qa-config.json."
elif [ -f "$CONFIG" ] && cmp -s "$CONFIG" "$DEMO"; then
  rm "$CONFIG"
  echo "✓ Removed the demo config (you had no config before the demo)."
elif [ -f "$CONFIG" ]; then
  echo "• qa-config.json is not the demo config and there is no backup — leaving it untouched."
else
  echo "• Nothing to restore."
fi

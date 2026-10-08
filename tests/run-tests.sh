#!/usr/bin/env bash
# Run the full Tech9 QA Harness test suite.
# Prerequisites: bats-core (brew install bats-core), Node.js, jq

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Check bats
if ! command -v bats &>/dev/null; then
  echo "ERROR: bats-core is required."
  if command -v brew &>/dev/null; then
    echo "  Install it: brew install bats-core"
  else
    echo "  Install it: https://bats-core.readthedocs.io/en/stable/installation.html"
  fi
  exit 1
fi

# Check jq
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required."
  echo "  Install it: brew install jq"
  exit 1
fi

# Install Node deps for schema validation (ajv)
if [ ! -f "$SCRIPT_DIR/node_modules/ajv/package.json" ]; then
  echo "Installing test dependencies (ajv)..."
  npm install --prefix "$SCRIPT_DIR" --silent
fi

echo ""
echo "Tech9 QA Harness — Test Suite"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
cd "$REPO_ROOT"
bats \
  tests/prod-guard.bats \
  tests/env-detector.bats \
  tests/session-init.bats \
  tests/schema-validation.bats \
  tests/wording-lint.bats \
  tests/check-prereqs.bats \
  tests/preflight.bats \
  tests/settings-lint.bats \
  tests/tracker.bats \
  tests/results.bats \
  tests/triage.bats \
  tests/commands-adapter-drift.bats \
  tests/evals.bats \
  tests/layer5-guard.bats \
  tests/layer5-guard-py-rb.bats \
  tests/demo.bats

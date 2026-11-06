#!/usr/bin/env bash
# Run the full Tech9 QA Harness test suite.
# Prerequisites: bats-core (brew install bats-core), Node.js (>= 22), jq
# Optional (the tests that need them SKIP, and this script says so): a python3 that actually runs (Python e2e templates),
# ruby (RSpec template), Node >= 22.6 (TypeScript templates, via type stripping).

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

# Optional interpreters: say what will be skipped, so a green run is not mistaken for full coverage.
# shellcheck source=helpers/find-python.bash
source "$SCRIPT_DIR/helpers/find-python.bash"
echo ""
if find_python; then echo "  python3: $PY"; else echo "  python3: no working interpreter — the Python guard tests will be SKIPPED (a macOS python3 shim fails until the Xcode licence is accepted)"; fi
if ruby -e 'exit 0' >/dev/null 2>&1; then echo "  ruby:    $(ruby -e 'print RUBY_VERSION')"; else echo "  ruby:    not available — the Ruby guard tests will be SKIPPED"; fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 6 ]; }; then echo "  node:    $(node --version 2>/dev/null) — the TypeScript guard tests will be SKIPPED (need >= 22.6)"; else echo "  node:    $(node --version)"; fi

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
  tests/suite-wiring.bats \
  tests/tracker.bats \
  tests/results.bats \
  tests/triage.bats \
  tests/commands-adapter-drift.bats \
  tests/evals.bats \
  tests/layer5-guard.bats \
  tests/layer5-guard-py-rb.bats \
  tests/guard-parity.bats \
  tests/demo.bats

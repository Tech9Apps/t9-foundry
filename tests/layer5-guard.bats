#!/usr/bin/env bats
# Tests for the Layer 5 runtime guard in the TypeScript e2e templates.
# Runs the real .ts files via Node's built-in type stripping (Node >= 22.6) —
# no TypeScript toolchain needed. See tests/helpers/layer5-guard-check.mjs.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
CHECK="$BATS_TEST_DIRNAME/helpers/layer5-guard-check.mjs"

setup() {
  local major minor
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  minor=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)
  if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 6 ]; }; then
    skip "needs Node >= 22.6 for --experimental-strip-types (found $(node --version 2>/dev/null))"
  fi
}

@test "playwright prod-guard.ts: warn/enforce/allowlist/opt-out behavior" {
  run node --experimental-strip-types "$CHECK" "$REPO_ROOT/templates/e2e/playwright/support/prod-guard.ts"
  [[ "$output" =~ "OK" ]]
  [ "$status" -eq 0 ]
}

@test "cypress prod-guard.ts: warn/enforce/allowlist/opt-out behavior" {
  run node --experimental-strip-types "$CHECK" "$REPO_ROOT/templates/e2e/cypress/support/prod-guard.ts"
  [[ "$output" =~ "OK" ]]
  [ "$status" -eq 0 ]
}

@test "webdriverio prod-guard.ts: warn/enforce/allowlist/opt-out behavior" {
  run node --experimental-strip-types "$CHECK" "$REPO_ROOT/templates/e2e/webdriverio/support/prod-guard.ts"
  [[ "$output" =~ "OK" ]]
  [ "$status" -eq 0 ]
}

@test "the three TS guards stay in sync (same validateNotProduction body)" {
  body() { sed -n '/^export interface ProdGuardOptions/,$p' "$1"; }
  [ "$(body "$REPO_ROOT/templates/e2e/playwright/support/prod-guard.ts")" = "$(body "$REPO_ROOT/templates/e2e/cypress/support/prod-guard.ts")" ]
  [ "$(body "$REPO_ROOT/templates/e2e/playwright/support/prod-guard.ts")" = "$(body "$REPO_ROOT/templates/e2e/webdriverio/support/prod-guard.ts")" ]
}

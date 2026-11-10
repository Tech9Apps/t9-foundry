#!/usr/bin/env bats
# Layer 5 is only as good as its call sites. tests/guard-parity.bats proves every guard DECIDES the same way; nothing there would notice an entry
# point that stopped CALLING it correctly: removing guardOptionsFromConfig(qa) from global-setup.ts, cypress.config.ts or wdio.conf.ts leaves every
# decision test green while enforce-via-config silently stops working in that framework. These pin the call sites.
#
# The entry points import the frameworks themselves (@playwright/test, cypress, webdriverio), which are not installed here, so they are read, not run;
# what they depend on in prod-guard.ts IS run (tests/helpers/guard-wiring-ts.mjs).

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
E2E="$REPO_ROOT/templates/e2e"

need_node_22_6() {
  local major minor
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  minor=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)
  if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 6 ]; }; then
    skip "needs Node >= 22.6 for --experimental-strip-types (found $(node --version 2>/dev/null))"
  fi
}

# <file> <pattern> <what>: the file must match the extended regex, or the test fails naming the file
must_match() {
  grep -Eq -- "$2" "$1" || { echo "${1#"$REPO_ROOT"/}: $3"; return 1; }
}

@test "playwright, cypress and webdriverio each import guardOptionsFromConfig and pass guardOptionsFromConfig(qa) to validateNotProduction" {
  for entry in playwright/support/global-setup.ts cypress/cypress.config.ts webdriverio/wdio.conf.ts; do
    f="$E2E/$entry"
    [ -f "$f" ]
    must_match "$f" "^import \{[^}]*validateNotProduction[^}]*\} from '[^']*prod-guard'" "no longer imports validateNotProduction from prod-guard"
    must_match "$f" "^import \{[^}]*guardOptionsFromConfig[^}]*\} from '[^']*prod-guard'" "no longer imports guardOptionsFromConfig from prod-guard"
    must_match "$f" "validateNotProduction\([^;]*,[^;]*,[[:space:]]*guardOptionsFromConfig\(qa\)\)" "does not call validateNotProduction(url, patterns, guardOptionsFromConfig(qa)): enforce-via-config would stop working"
  done
}

@test "each of those calls is made where it runs before any test (config load, global setup, onPrepare), not in a function nobody calls" {
  grep -Eq "^export default async function globalSetup" "$E2E/playwright/support/global-setup.ts"
  grep -Eq "^[[:space:]]*globalSetup:[[:space:]]*require\.resolve\('\./support/global-setup'\)" "$E2E/playwright/playwright.config.ts"
  # cypress: at the top level of the config module, so it runs when the config loads
  [ "$(grep -n 'validateNotProduction(baseUrl' "$E2E/cypress/cypress.config.ts" | cut -d: -f2- | grep -c '^validateNotProduction')" -eq 1 ]
  grep -Eq "onPrepare\(\)" "$E2E/webdriverio/wdio.conf.ts"
}

@test "guardOptionsFromConfig turns qa-config.json into the guard's options, and validateNotProduction enforces only when given them (all three TypeScript copies)" {
  need_node_22_6
  for fw in playwright cypress webdriverio; do
    run bash -c "node --experimental-strip-types '$BATS_TEST_DIRNAME/helpers/guard-wiring-ts.mjs' '$E2E/$fw/support/prod-guard.ts' 2>/dev/null"
    echo "$fw: $output"
    [ "$status" -eq 0 ]
    [ "$output" = "OK" ]
  done
}

@test "pytest, selenium and rspec call the guard at session start, before any test, and the guard reads the config itself" {
  for fw in pytest selenium; do
    f="$E2E/$fw/conftest.py"
    must_match "$f" "^from support\.prod_guard import validate_not_production" "no longer imports validate_not_production"
    must_match "$f" "^def pytest_sessionstart\(" "no longer has a pytest_sessionstart hook"
    awk '/^def pytest_sessionstart\(/ {in_hook=1; next} /^(def |@pytest)/ {in_hook=0} in_hook && /validate_not_production\(base_url\)/ {found=1} END {exit !found}' "$f" \
      || { echo "$fw/conftest.py: pytest_sessionstart does not call validate_not_production(base_url)"; false; }
    must_match "$E2E/$fw/support/prod_guard.py" "qa-config\.json" "the guard no longer looks for qa-config.json itself (the entry point passes it no options)"
  done
  f="$E2E/rspec/spec/spec_helper.rb"
  must_match "$f" "config\.before\(:suite\)" "no longer has a before(:suite) hook"
  must_match "$f" "ProdGuard\.validate_not_production\(base_url\)" "no longer calls ProdGuard.validate_not_production(base_url)"
  must_match "$E2E/rspec/spec/support/prod_guard.rb" "qa-config\.json" "the guard no longer looks for qa-config.json itself (the entry point passes it no options)"
}

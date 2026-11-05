#!/usr/bin/env bats
# One decision procedure for "is this URL production?", implemented five times: the shell hooks' reference (hooks/lib/url-guard.js)
# and the runtime guards in templates/e2e (TypeScript x3, Python x2, Ruby). "Layer 5 behaves like the shell guards" is only true if
# every one of them gives the same answer, so tests/fixtures/guard-cases.json — written from the design, including every bypass a
# reviewer found — is run against ALL of them, and the lists they depend on are compared for equality.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
HELPERS="$BATS_TEST_DIRNAME/helpers"
load helpers/find-python

setup() {
  unset QA_AUTONOMOUS QA_HARNESS_DIR CLAUDE_PROJECT_DIR
  export PYTHONDONTWRITEBYTECODE=1
}

need_node_22_6() {
  local major minor
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  minor=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)
  if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 6 ]; }; then
    skip "needs Node >= 22.6 for --experimental-strip-types (found $(node --version 2>/dev/null))"
  fi
}

@test "the reference implementation (hooks/lib/url-guard.js) gives every case its documented decision and reason" {
  run node "$HELPERS/guard-cases-js.js"
  [ "$status" -eq 0 ]
  [ "$output" = "OK" ]
}

@test "the TypeScript runtime guards (playwright, cypress, webdriverio) give every case the same decision and reason" {
  need_node_22_6
  for fw in playwright cypress webdriverio; do
    run bash -c "node --experimental-strip-types '$HELPERS/guard-cases-ts.mjs' '$REPO_ROOT/templates/e2e/$fw/support/prod-guard.ts' 2>/dev/null"
    echo "$fw: $output"
    [ "$status" -eq 0 ]
    [ "$output" = "OK" ]
  done
}

@test "the Ruby runtime guard (rspec) gives every case the same decision and reason" {
  ruby -e 'exit 0' >/dev/null 2>&1 || skip "ruby does not run here"
  run ruby "$HELPERS/guard-cases-rb.rb"
  [ "$status" -eq 0 ]
  [ "$output" = "OK" ]
}

@test "the Python runtime guards (pytest, selenium) give every case the same decision and reason" {
  find_python || skip "no working python3 (a macOS python3 shim fails until the Xcode licence is accepted)"
  for fw in pytest selenium; do
    run "$PY" "$HELPERS/guard-cases-py.py" "$REPO_ROOT/templates/e2e/$fw"
    echo "$fw: $output"
    [ "$status" -eq 0 ]
    [ "$output" = "OK" ]
  done
}

@test "the lists the decision depends on (staging tokens, production tokens, reserved TLDs, known hosts) are identical in every implementation" {
  run node "$HELPERS/guard-constants-check.js"
  [ "$status" -eq 0 ]
  [ "$output" = "OK" ]
}

@test "the real shell hooks (prod-guard.sh for commands, env-detector.sh for file content) give the same decisions in both modes" {
  run node "$HELPERS/guard-cases-hooks.js"
  [ "$status" -eq 0 ]
  [ "$output" = "OK" ]
}

@test "the case table cannot quietly shrink: every decision path and every known bypass family is covered" {
  run node -e '
    const t = require(process.argv[1]);
    const reasons = new Set(t.cases.map((c) => c.reason));
    const need = ["PROD_PATTERN", "UNPARSEABLE", "UNVERIFIABLE_HOST", "HEURISTIC_DISABLED", "EXEMPT_HOST", "ALLOWED_PATTERN", "TEST_ENV_HOST", "NONPROD_HOST", "UNRECOGNIZED_HOST"];
    const groups = t.cases.reduce((m, c) => ({ ...m, [c.group]: (m[c.group] || 0) + 1 }), {});
    const needGroups = { "prod-pattern-spellings": 15, "allowed-patterns": 5, "heuristic-bypasses": 25, "unverifiable-hosts": 8, "not-production": 20, "known-hosts": 8, "test-environment": 2, "heuristic-off": 3 };
    const problems = [];
    for (const r of need) if (!reasons.has(r)) problems.push("no case reaches " + r);
    for (const [g, n] of Object.entries(needGroups)) if ((groups[g] || 0) < n) problems.push("group " + g + " has " + (groups[g] || 0) + " cases, expected at least " + n);
    // every case must say what it expects in BOTH modes
    for (const c of t.cases) if (!c.expect || !c.expect.enforce || !c.expect.warn) problems.push("case without both modes: " + c.url);
    console.log(problems.length ? problems.join("\n") : "OK");
    process.exit(problems.length ? 1 : 0);
  ' "$BATS_TEST_DIRNAME/fixtures/guard-cases.json"
  [ "$status" -eq 0 ]
  [ "$output" = "OK" ]
}

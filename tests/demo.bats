#!/usr/bin/env bats
# The embedded demo (demo/) is only useful if it keeps behaving exactly as documented:
# the app must keep its two planted bugs, the fixes must keep working, the sample outputs
# must match the real test suite, and the scripts must never clobber a user's real config.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
DEMO="$REPO_ROOT/demo"
EXPECTED_FAILS="DEMO-101/TC-005 DEMO-102/TC-006"

setup() {
  TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/qa-test.XXXXXX")"
}

teardown() {
  rm -rf "$TEST_TMP"
}

# Run the demo app's suite in <dir> (default: the real app); print "status|name" lines, sorted.
suite_results() {
  local dir="${1:-$DEMO/app}"
  (cd "$dir" && node --test --test-reporter=tap 2>&1) \
    | grep -E '^\s*(not ok|ok) [0-9]+ - DEMO-' \
    | sed -E 's/^[[:space:]]*(not ok|ok) [0-9]+ - (DEMO-[0-9]+\/TC-[0-9]+).*/\1|\2/' | sort -t'|' -k2,2
}
failing_ids() { grep '^not ok|' | cut -d'|' -f2 | tr '\n' ' ' | sed 's/ $//'; }

# ── The app and its planted bugs ─────────────────────────────────────────────

@test "the demo app has exactly the two planted bugs (and nothing else fails)" {
  [ "$(suite_results | failing_ids)" = "$EXPECTED_FAILS" ]
}

@test "the demo app suite has 22 automated checks" {
  [ "$(suite_results | wc -l | tr -d ' ')" -eq 22 ]
}

@test "fixes.patch turns the suite green, and reverses cleanly" {
  cp -R "$DEMO/app" "$TEST_TMP/app"
  patch -p1 -d "$TEST_TMP/app" --silent < "$DEMO/fixes.patch"
  [ -z "$(suite_results "$TEST_TMP/app" | failing_ids)" ]
  patch -R -p1 -d "$TEST_TMP/app" --silent < "$DEMO/fixes.patch"
  [ "$(suite_results "$TEST_TMP/app" | failing_ids)" = "$EXPECTED_FAILS" ]
}

@test "apply-fixes.sh applies, is idempotent, and reverts" {
  cp -R "$DEMO/app" "$TEST_TMP/app"
  run env QA_DEMO_APP="$TEST_TMP/app" bash "$DEMO/apply-fixes.sh"
  [ "$status" -eq 0 ]
  [ -z "$(suite_results "$TEST_TMP/app" | failing_ids)" ]
  run env QA_DEMO_APP="$TEST_TMP/app" bash "$DEMO/apply-fixes.sh"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "already applied" ]]
  run env QA_DEMO_APP="$TEST_TMP/app" bash "$DEMO/apply-fixes.sh" --revert
  [ "$status" -eq 0 ]
  [ "$(suite_results "$TEST_TMP/app" | failing_ids)" = "$EXPECTED_FAILS" ]
}

@test "the app's HTTP adapter routes, authenticates and rejects bad input (no socket needed)" {
  run node "$BATS_TEST_DIRNAME/helpers/demo-server-check.js"
  [ "$status" -eq 0 ]
  [[ "$output" == "OK" ]]
}

@test "the UI's inline script is syntactically valid JavaScript" {
  sed -n '/<script>/,/<\/script>/p' "$DEMO/app/public/index.html" | sed '1d;$d' > "$TEST_TMP/ui.js"
  [ -s "$TEST_TMP/ui.js" ]
  run node --check "$TEST_TMP/ui.js"
  [ "$status" -eq 0 ]
}

@test "the app has zero npm dependencies" {
  run jq -e '(.dependencies // {}) == {} and (.devDependencies // {}) == {}' "$DEMO/app/package.json"
  [ "$status" -eq 0 ]
}

# ── Sample outputs stay in sync with the real suite ─────────────────────────

@test "every automated check has a matching case in demo/expected/" {
  while IFS='|' read -r _ id; do
    ticket="${id%%/*}"; tc="${id##*/}"
    grep -q "^### $tc:" "$DEMO/expected/$ticket-test-cases.md"
  done < <(suite_results)
}

@test "the run report's counts match the real suite" {
  total=$(suite_results | wc -l | tr -d ' ')
  failed=$(suite_results | grep -c '^not ok|' || true)
  passed=$((total - failed))
  grep -q "$total automated checks · $passed pass · $failed fail" "$DEMO/expected/run-report.md"
}

@test "each failing check has a sample bug report that quotes it" {
  for id in $EXPECTED_FAILS; do
    ticket="${id%%/*}"
    report=$(ls "$DEMO"/expected/bug-"$ticket"-*.md)
    grep -q "$id" "$report"
  done
}

@test "every UI selector named in the sample cases exists in the app's HTML" {
  ids=$(grep -h '^- \*\*Selectors/Elements:\*\*' "$DEMO"/expected/*-test-cases.md | grep -oE '`[a-z-]+`' | tr -d '`' | sort -u)
  [ -n "$ids" ]
  for id in $ids; do
    grep -q "data-testid=\"$id\"" "$DEMO/app/public/index.html"
  done
}

# ── Config and scripts ───────────────────────────────────────────────────────

@test "the demo config validates against the schema" {
  run node "$BATS_TEST_DIRNAME/validate-schema.js" "$DEMO/qa-config.demo.json"
  [ "$status" -eq 0 ]
}

@test "generated demo files (including the optional Playwright step) are git-ignored" {
  cd "$REPO_ROOT"
  for f in demo/output/test-cases/x.md demo/app/e2e/tests/x.spec.ts demo/app/e2e/package.json \
           demo/app/playwright-report/index.html demo/app/test-results/.last-run.json demo/app/node_modules/x/index.js; do
    git check-ignore -q "$f"
  done
}

@test "the demo config sends generated e2e specs to the git-ignored demo/app/e2e" {
  [ "$(jq -r '.testOutput.e2eTestsPath' "$DEMO/qa-config.demo.json")" = "./demo/app/e2e" ]
}

@test "no file named qa-config.json is committed under demo/ (it is gitignored repo-wide)" {
  [ -z "$(find "$DEMO" -name qa-config.json)" ]
}

@test "the guards treat the demo config correctly: production blocked, local test env allowed" {
  mkdir -p "$TEST_TMP/project"
  cp "$DEMO/qa-config.demo.json" "$TEST_TMP/project/qa-config.json"
  jq -n '{"tool_input":{"command":"curl -s https://shop.brewandco.com/api/checkout"}}' > "$TEST_TMP/prod.json"
  jq -n '{"tool_input":{"command":"curl -s http://localhost:4173/api/products"}}' > "$TEST_TMP/local.json"
  run env CLAUDE_PROJECT_DIR="$TEST_TMP/project" bash "$REPO_ROOT/hooks/prod-guard.sh" < "$TEST_TMP/prod.json"
  [ "$status" -eq 2 ]
  run env CLAUDE_PROJECT_DIR="$TEST_TMP/project" bash "$REPO_ROOT/hooks/prod-guard.sh" < "$TEST_TMP/local.json"
  [ "$status" -eq 0 ]
}

@test "preflight says GO for the demo config" {
  run env QA_AUTONOMOUS=1 bash "$REPO_ROOT/scripts/preflight.sh" --skip-network --config "$DEMO/qa-config.demo.json"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "GO:" ]]
}

@test "use-demo-config.sh installs the demo config when there is none, and restore removes it" {
  mkdir -p "$TEST_TMP/root"
  run env QA_DEMO_ROOT="$TEST_TMP/root" bash "$DEMO/use-demo-config.sh"
  [ "$status" -eq 0 ]
  cmp -s "$TEST_TMP/root/qa-config.json" "$DEMO/qa-config.demo.json"
  run env QA_DEMO_ROOT="$TEST_TMP/root" bash "$DEMO/restore-demo-config.sh"
  [ "$status" -eq 0 ]
  [ ! -e "$TEST_TMP/root/qa-config.json" ]
}

@test "use-demo-config.sh backs up a real config and restore returns it byte-for-byte" {
  mkdir -p "$TEST_TMP/root"
  printf '{ "project": { "name": "My Real Project" } }\n' > "$TEST_TMP/root/qa-config.json"
  cp "$TEST_TMP/root/qa-config.json" "$TEST_TMP/original.json"

  run env QA_DEMO_ROOT="$TEST_TMP/root" bash "$DEMO/use-demo-config.sh"
  [ "$status" -eq 0 ]
  cmp -s "$TEST_TMP/root/qa-config.json.backup-before-demo" "$TEST_TMP/original.json"
  cmp -s "$TEST_TMP/root/qa-config.json" "$DEMO/qa-config.demo.json"

  run env QA_DEMO_ROOT="$TEST_TMP/root" bash "$DEMO/restore-demo-config.sh"
  [ "$status" -eq 0 ]
  cmp -s "$TEST_TMP/root/qa-config.json" "$TEST_TMP/original.json"
  [ ! -e "$TEST_TMP/root/qa-config.json.backup-before-demo" ]
}

@test "use-demo-config.sh refuses to overwrite an existing backup" {
  mkdir -p "$TEST_TMP/root"
  printf 'precious\n' > "$TEST_TMP/root/qa-config.json.backup-before-demo"
  printf '{ "project": { "name": "Another" } }\n' > "$TEST_TMP/root/qa-config.json"
  run env QA_DEMO_ROOT="$TEST_TMP/root" bash "$DEMO/use-demo-config.sh"
  [ "$status" -eq 1 ]
  [ "$(cat "$TEST_TMP/root/qa-config.json.backup-before-demo")" = "precious" ]
  grep -q "Another" "$TEST_TMP/root/qa-config.json"
}

@test "restore leaves a non-demo config alone when there is no backup" {
  mkdir -p "$TEST_TMP/root"
  printf '{ "project": { "name": "Mine" } }\n' > "$TEST_TMP/root/qa-config.json"
  run env QA_DEMO_ROOT="$TEST_TMP/root" bash "$DEMO/restore-demo-config.sh"
  [ "$status" -eq 0 ]
  grep -q "Mine" "$TEST_TMP/root/qa-config.json"
}

# ── The 2-minute tour ────────────────────────────────────────────────────────

@test "run-demo.sh --no-pause runs the whole tour and exits 0" {
  run bash "$DEMO/run-demo.sh" --no-pause
  [ "$status" -eq 0 ]
  [[ "$output" =~ "20 passed, 2 failed" ]]
  [[ "$output" =~ "BLOCKED (exit 2)" ]]
  [[ "$output" =~ "GO: no blocking issues" ]]
  [[ "$output" =~ "# fail 0" ]]
}

# ── The tracker half of the demo (in-memory tracker, real adapter CLI) ──────────

@test "tracker-demo: the same flow works against all five trackers" {
  for t in github clickup azure gitlab bitbucket; do
    run node "$DEMO/tracker-demo.js" --tracker "$t"
    [ "$status" -eq 0 ]
    [[ "$output" =~ "26 created" ]]
    [[ "$output" =~ "3 stories · 26 test cases · 2 bugs · 3 comments" ]]
    [[ "$output" =~ "0 created, 31 already existed" ]]
    [[ "$output" =~ "no duplicate" ]]
    [[ ! "$output" =~ "DEMO INTEGRITY" ]]
  done
}

@test "tracker-demo: rejects an unknown tracker" {
  run node "$DEMO/tracker-demo.js" --tracker jira
  [ "$status" -eq 2 ]
}

@test "tracker-demo: parses every sample test case with a priority, steps and an expected result" {
  run node -e "
    const fs = require('fs');
    const { parseTestCases, parseTicket, parseBug } = require('$DEMO/tracker-demo.js');
    let total = 0; const bad = [];
    for (const t of ['DEMO-101', 'DEMO-102', 'DEMO-103']) {
      for (const c of parseTestCases(fs.readFileSync('$DEMO/expected/' + t + '-test-cases.md', 'utf8'))) {
        total += 1;
        const last = c.steps[c.steps.length - 1];
        if (!c.priority || !c.steps.length || !last.expected) bad.push(t + '/' + c.tcId);
      }
      const tk = parseTicket('$DEMO/tickets/' + t + '.md');
      if (!tk.title || !tk.description || tk.acceptance.split('\n').filter((l) => /^\\s*\\d+\\./.test(l)).length < 5) bad.push(t + ' ticket');
    }
    for (const f of fs.readdirSync('$DEMO/expected').filter((x) => x.startsWith('bug-'))) {
      const b = parseBug('$DEMO/expected/' + f);
      if (!b.title || !b.body || !b.priority) bad.push(f);
    }
    console.log(total + ' cases; problems: ' + JSON.stringify(bad));
  "
  [ "$status" -eq 0 ]
  [[ "$output" == "26 cases; problems: []" ]]
}

@test "run-demo.sh --tracker adds Act 8 and still exits 0" {
  run bash "$DEMO/run-demo.sh" --no-pause --tracker azure
  [ "$status" -eq 0 ]
  [[ "$output" =~ "Act 8 · Step 1" ]]
  [[ "$output" =~ "Azure DevOps" ]]
  [[ "$output" =~ "no duplicate" ]]
}

@test "run-demo.sh --tracker defaults to github, and the plain tour has no Act 8" {
  run bash "$DEMO/run-demo.sh" --no-pause --tracker
  [ "$status" -eq 0 ]
  [[ "$output" =~ "GitHub Issues" ]]
  run bash "$DEMO/run-demo.sh" --no-pause
  [[ ! "$output" =~ "Act 8" ]]
  [[ "$output" =~ "--tracker" ]]   # the wrap-up points at it
}

@test "run-demo.sh --tracker rejects an unknown tracker name" {
  run bash "$DEMO/run-demo.sh" --no-pause --tracker bogus
  [ "$status" -eq 2 ]
}

@test "the tracker demo writes nothing into the working tree" {
  before=$(cd "$REPO_ROOT" && git status --porcelain | sort)
  run node "$DEMO/tracker-demo.js"
  [ "$status" -eq 0 ]
  after=$(cd "$REPO_ROOT" && git status --porcelain | sort)
  [ "$before" = "$after" ]
}

@test "run-demo.sh does not modify the working tree" {
  before=$(cd "$REPO_ROOT" && git status --porcelain -- demo | sort)
  run bash "$DEMO/run-demo.sh" --no-pause
  [ "$status" -eq 0 ]
  after=$(cd "$REPO_ROOT" && git status --porcelain -- demo | sort)
  [ "$before" = "$after" ]
}

@test "run-demo.sh fails loudly when the demo app no longer behaves as documented" {
  # Copy just what the tour needs, fix the bugs in the copy, and expect the tour to notice.
  mkdir -p "$TEST_TMP/repo"
  cp -R "$REPO_ROOT/demo" "$REPO_ROOT/hooks" "$REPO_ROOT/scripts" "$TEST_TMP/repo/"
  patch -p1 -d "$TEST_TMP/repo/demo/app" --silent < "$DEMO/fixes.patch"
  run bash "$TEST_TMP/repo/demo/run-demo.sh" --no-pause
  [ "$status" -eq 1 ]
  [[ "$output" =~ "DEMO INTEGRITY" ]]
}

@test "run-demo.sh rejects an unknown option" {
  run bash "$DEMO/run-demo.sh" --bogus
  [ "$status" -eq 2 ]
}

@test "/demo command and the docs point at files that exist" {
  for f in demo/README.md demo/run-demo.sh demo/use-demo-config.sh demo/restore-demo-config.sh demo/apply-fixes.sh \
           demo/fixes.patch demo/qa-config.demo.json demo/expected/run-report.md; do
    [ -f "$REPO_ROOT/$f" ]
  done
  [ -f "$REPO_ROOT/.claude/commands/demo.md" ]
  for t in DEMO-101 DEMO-102 DEMO-103; do [ -f "$DEMO/tickets/$t.md" ]; done
}

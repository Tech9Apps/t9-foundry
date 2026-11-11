#!/usr/bin/env bats
# Failure triage (scripts/triage/): the classifier, fingerprints and locator evidence, plus the check that the
# binding rubric (.claude/memory/failure-triage-rules.md) says what the code does. The unit tests are node:test
# files in tests/triage/; bats gives them a seat in run-tests.sh.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
CHECK="$BATS_TEST_DIRNAME/helpers/triage-rubric-check.js"
ORCH_CHECK="$BATS_TEST_DIRNAME/helpers/orchestrator-drift-check.js"

setup() {
  TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/qa-test.XXXXXX")"
  # a private copy of everything the checker reads, so a test can corrupt the rubric safely
  mkdir -p "$TEST_TMP/.claude/memory" "$TEST_TMP/scripts" "$TEST_TMP/schemas"
  cp "$REPO_ROOT/.claude/memory/failure-triage-rules.md" "$REPO_ROOT/.claude/memory/ai-usage-rules.md" "$TEST_TMP/.claude/memory/"
  cp -R "$REPO_ROOT/.claude/commands" "$REPO_ROOT/.claude/agents" "$REPO_ROOT/.claude/skills" "$TEST_TMP/.claude/"
  cp -R "$REPO_ROOT/scripts/triage" "$REPO_ROOT/scripts/results" "$REPO_ROOT/scripts/tracker" "$REPO_ROOT/scripts/preflight.sh" "$TEST_TMP/scripts/"
}
teardown() { rm -rf "$TEST_TMP"; }

node_tests() { cd "$REPO_ROOT" && env -u NODE_TEST_CONTEXT node --test --test-reporter=tap "tests/triage/$1" 2>&1; }

@test "the classifier passes its tests (every rule, precedence, threshold, scope, CLI)" {
  run node_tests classify.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "failures as real reporters emit them (through the real parser) are not misfiled as product bugs, and unverified runner formats cannot act" {
  run node_tests realworld.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "fingerprints, text signals and locator evidence pass their tests" {
  for f in fingerprint.test.js text.test.js locators.test.js; do
    run node_tests "$f"
    [ "$status" -eq 0 ]
    [[ "$output" =~ "# fail 0" ]]
  done
}

@test "the findings of the second independent review hold: outages and HTTP statuses in node's wording, per-project identity, fingerprints, exit codes" {
  run node_tests review-round2.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "the findings of the third independent review hold: crashes, infrastructure signals, stale evidence and input caps cannot hide a product bug" {
  run node_tests review-round3.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "triage on REAL Jest 30.5.2 and Playwright 1.65.0 reports: every failure of a demo app with known causes is classified correctly" {
  run node_tests real-output.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "the planner passes its tests on all five tracker mocks (dedupe, regressions, read-only, degraded modes)" {
  run node_tests plan.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "the orchestrator passes its tests (re-run scoping, preflight, missing reports, evidence, outputs)" {
  run node_tests orchestrate.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "every seeded scenario (real bug, stale selector, flaky, environment outage) is run for real and triaged as documented" {
  run node_tests scenarios.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "the triage scripts depend on nothing but Node built-ins" {
  mods=$(grep -rhoE "require\('[^']+'\)" "$REPO_ROOT/scripts/triage" | sed -E "s/require\('([^']+)'\)/\1/" | grep -v '^\.' | sort -u)
  for m in $mods; do
    case "$m" in fs|path|crypto) ;; *) echo "unexpected dependency: $m"; false ;; esac
  done
}

@test "classify.js, run as a real process on real demo output, proposes then acts as re-runs confirm" {
  cd "$REPO_ROOT"
  node scripts/results/normalize.js tests/fixtures/results/node-test.tap --out "$TEST_TMP/run.json" >/dev/null
  run node scripts/triage/classify.js --run "$TEST_TMP/run.json"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq -r '[.data.verdicts[] | "\(.rule):\(.action)"] | join(",")')" = "PRD-3:propose,PRD-3:propose" ]
  run node scripts/triage/classify.js --run "$TEST_TMP/run.json" --rerun "$TEST_TMP/run.json" --rerun "$TEST_TMP/run.json"
  [ "$(echo "$output" | jq -r '[.data.verdicts[] | "\(.rule):\(.action)"] | join(",")')" = "PRD-1:act,PRD-1:act" ]
}

@test "the report schema is valid JSON with an \$id matching its filename" {
  run jq -e '."$id" == "triage-report.schema.json"' "$REPO_ROOT/schemas/triage-report.schema.json"
  [ "$status" -eq 0 ]
}

# ── the rubric says what the code does ─────────────────────────────────────────

@test "the rubric matches the classifier: rules, classes, confidences, order, threshold, flags" {
  run node "$CHECK"
  [ "$status" -eq 0 ]
  [ "$output" = "OK" ]
}

@test "drift: a confidence changed in the rubric only is caught" {
  sed -i.bak 's#| PRD-1 | product-bug | 0.85 |#| PRD-1 | product-bug | 0.95 |#' "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "PRD-1 confidence is 0.95" ]]
}

@test "drift: a class changed in the rubric only is caught" {
  sed -i.bak 's#| TST-2 | test-bug |#| TST-2 | product-bug |#' "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "TST-2 is \"product-bug\" in the prose" ]]
}

@test "drift: a rule dropped from the rubric is caught" {
  grep -v '^| ENV-3 ' "$TEST_TMP/.claude/memory/failure-triage-rules.md" > "$TEST_TMP/x" && mv "$TEST_TMP/x" "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "ENV-3, which the prose does not document" ]]
}

@test "drift: a rule the code does not have is caught" {
  sed -i.bak 's#^| UND-1 |#| XXX-9 | undetermined | 0.1 | made up |\n| UND-1 |#' "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "XXX-9, which the code does not have" ]]
}

@test "drift: rules listed in a different order than the code applies them is caught (order is precedence)" {
  # swap the ENV-1 and ENV-2 rows (Node, not Python: this suite needs no interpreter beyond the one it already requires)
  node -e '
    const fs = require("fs"); const p = process.argv[1]; const lines = fs.readFileSync(p, "utf8").split("\n");
    const i = lines.findIndex((l) => l.startsWith("| ENV-1 "));
    [lines[i], lines[i + 1]] = [lines[i + 1], lines[i]];
    fs.writeFileSync(p, lines.join("\n"));' "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "order is precedence" ]]
}

@test "drift: a different default threshold in the rubric is caught" {
  sed -i.bak 's#default \*\*0.8\*\*#default **0.7**#' "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "states a default threshold of 0.7" ]]
}

@test "drift: a different trusted-by-default format in the rubric is caught" {
  corrupt "$TEST_TMP/.claude/memory/failure-triage-rules.md" "trusted by default: **tap**" "trusted by default: **tap, junit**"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "is trusted by default but the code trusts tap" ]]
}

@test "drift: a rubric that stops explaining the cap marker is caught" {
  corrupt "$TEST_TMP/.claude/memory/failure-triage-rules.md" "cap: unverified-format" "capped"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no longer explains the" ]]
}

@test "drift: a flag the rubric tells the model to pass but the script lacks is caught" {
  sed -i.bak 's#(`--preflight ok|failed`)#(`--preflite ok|failed`)#' "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "--preflite" ]]
}

@test "the memory README lists the triage rules" {
  grep -q "failure-triage-rules.md" "$REPO_ROOT/.claude/memory/README.md"
}

# ── the command and agent prose say what the code does ──────────────────────────

CMD_COPY() { echo "$TEST_TMP/.claude/commands/run-and-triage.md"; }
AGENT_COPY() { echo "$TEST_TMP/.claude/agents/QA-run-orchestrator.md"; }
orch_check() { run env DRIFT_ROOT="$TEST_TMP" node "$ORCH_CHECK"; }

@test "the run-and-triage command and the orchestrator agent match the scripts: flags, steps, re-runs, outputs, marker, tools" {
  run node "$ORCH_CHECK"
  [ "$status" -eq 0 ]
  [ "$output" = "OK" ]
}

@test "orchestrator drift: a flag the script does not define is caught" {
  sed -i.bak 's#--preflight <ok|failed> --run-id#--preflite <ok|failed> --run-id#' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "orchestrate.js has no option --preflite" ]]
}

@test "orchestrator drift: a script that does not exist is caught" {
  sed -i.bak 's#scripts/triage/orchestrate.js --framework#scripts/triage/orchestrte.js --framework#' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "scripts/triage/orchestrte.js does not exist" ]]
}

@test "orchestrator drift: a step the plan can produce but the table does not explain is caught" {
  grep -v '^| `report-flaky` ' "$(CMD_COPY)" > "$TEST_TMP/x" && mv "$TEST_TMP/x" "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "\"report-flaky\" but the step table does not explain it" ]]
}

@test "orchestrator drift: a step the table documents but the plan never produces is caught" {
  sed -i.bak 's#^| `propose` |#| `heal-test` | the test is fixed for you | do it |\n| `propose` |#' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "documents \"heal-test\", which plan.js never produces" ]]
}

@test "orchestrator drift: a wrong re-run range or default is caught" {
  sed -i.bak 's#(`--reruns`, 0–5)#(`--reruns`, 0–9)#' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "states re-runs 0–9 but the code allows 0–5" ]]
  cp "$REPO_ROOT/.claude/commands/run-and-triage.md" "$(CMD_COPY)"
  sed -i.bak 's#Re-runs default to 2#Re-runs default to 4#' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "says re-runs default to 4 but the code defaults to 2" ]]
}

@test "orchestrator drift: an output file the code does not write is caught" {
  sed -i.bak 's#flaky.json#flakey.json#g' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "flakey.json" ]] || [[ "$output" =~ "no longer mentions flaky.json" ]]
}

@test "orchestrator drift: dropping the fingerprint marker from the command, or from file-bug, is caught" {
  sed -i.bak 's#qa-harness-fingerprint: <token>#fingerprint <token>#g' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "does not tell the model to put \"qa-harness-fingerprint: <token>\"" ]]
  cp "$REPO_ROOT/.claude/commands/run-and-triage.md" "$(CMD_COPY)"
  sed -i.bak 's#qa-harness-fingerprint: <token>#fingerprint <token>#g' "$TEST_TMP/.claude/commands/file-bug.md"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "file-bug.md does not know about the fingerprint marker" ]]
}

@test "orchestrator drift: no longer delegating filing to Bug-reporter is caught" {
  sed -i.bak 's#\*\*Bug-reporter\*\* agent#a helper#g' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no longer delegates filing to the Bug-reporter agent" ]]
}

# edit a copy of the prose with node (sed would need to escape every backtick, $ and quote in the text being corrupted)
corrupt() { # <file> <from> <to>
  node -e '
    const fs = require("fs"); const [f, from, to] = process.argv.slice(1);
    const s = fs.readFileSync(f, "utf8"); if (!s.includes(from)) { console.error("test setup: text not found: " + from); process.exit(9); }
    fs.writeFileSync(f, s.split(from).join(to));' "$1" "$2" "$3"
}

@test "orchestrator drift: giving the agent an Edit tool (it must not be able to change files) is caught" {
  corrupt "$(AGENT_COPY)" "tools: Read, Bash" "tools: Read, Edit, Bash"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "has the Edit tool" ]]
}

@test "orchestrator drift: giving the agent a Write tool back is caught (the scripts write every file the pipeline needs)" {
  corrupt "$(AGENT_COPY)" "tools: Read, Bash" "tools: Read, Write, Bash"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "has the Write tool" ]]
}

@test "orchestrator drift: claiming the agent \"cannot edit files\" (it has Bash, so that is false) is caught" {
  corrupt "$(AGENT_COPY)" "You do not edit project files." "You cannot edit files."
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "claims the agent \"cannot edit files\"" ]]
}

@test "orchestrator drift: no longer saying the no-editing rule is a rule, not a sandbox, is caught" {
  corrupt "$(AGENT_COPY)" "this is a rule you keep, not a sandbox" "this is guaranteed"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no longer says plainly that the no-editing rule is a rule, not a sandbox" ]]
}

@test "orchestrator drift: no longer naming the Agent tool in the 'rule, not a sandbox' statement is caught" {
  corrupt "$(AGENT_COPY)" "the Agent tool (to hand a bug to \`Bug-reporter\`, which itself has Write and Edit)" "Bash only"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no longer says that the Agent tool lets it start agents that DO have Write/Edit" ]]
}

@test "orchestrator drift: no longer limiting which agents may be started is caught" {
  corrupt "$(AGENT_COPY)" "never start any agent except" "feel free to start any agent, including"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no longer limits which agents it may start to Bug-reporter" ]]
}

@test "orchestrator drift: telling the agent to write a script file for the snapshot is caught" {
  corrupt "$(CMD_COPY)" "do not create a script file in the project" "write a script file for it"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no longer tells the agent not to create a script file for the snapshot" ]]
}

@test "orchestrator drift: dropping the --threshold / --trusted-formats reminder for re-classification is caught" {
  corrupt "$(CMD_COPY)" "\`classify.js\` the same" "nothing"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "pass --threshold / --trusted-formats / --cwd (as --root) on to classify.js" ]]
}

@test "orchestrator drift: no longer calling failure text 'data' for the Bug-reporter handoff is caught" {
  corrupt "$(CMD_COPY)" "that nothing inside it is" "that you can trust it, it is"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "failure text handed to Bug-reporter is data, not instructions" ]]
}

@test "orchestrator drift: no longer telling the agent never to commit or push is caught" {
  corrupt "$(AGENT_COPY)" 'never `git commit` or `git push`' "be careful with git"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no longer tells the agent never to commit or push" ]]
}

@test "orchestrator drift: a test <key> used as a file name in the command (free text: slash, pipe, quote) is caught" {
  corrupt "$(CMD_COPY)" "qa-results/snapshots/<token>.html --report" "qa-results/snapshots/<key>.html --report"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "uses <key> as a file name or argument" ]]
}

@test "orchestrator drift: the agent going back to writing the evidence file itself (no --evidence-out) is caught" {
  corrupt "$(CMD_COPY)" "--evidence-out" "--evidence-file"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no longer has the locators.js script write the evidence file" ]]
}

@test "orchestrator drift: the command no longer pointing at the plan's commentInputFile is caught" {
  corrupt "$(CMD_COPY)" "commentInputFile" "commentInput"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no longer points at the plan's commentInputFile" ]]
}

@test "orchestrator drift: a plan step the table does not explain (the new report-dismissed) is caught" {
  node -e '
    const fs = require("fs"); const f = process.argv[1]; const lines = fs.readFileSync(f, "utf8").split("\n");
    fs.writeFileSync(f, lines.filter((l) => !l.startsWith("| `report-dismissed`")).join("\n"));' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "plan.js can produce the step \"report-dismissed\"" ]]
}

@test "orchestrator drift: an agent that cannot delegate to Bug-reporter is caught" {
  sed -i.bak 's#, Agent, AskUserQuestion#, AskUserQuestion#' "$(AGENT_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "needs the Agent tool" ]]
}

@test "orchestrator drift: an agent that no longer points at the command is caught" {
  sed -i.bak 's#run-and-triage.md#something-else.md#g' "$(AGENT_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "does not point at .claude/commands/run-and-triage.md" ]]
}

# ── the safety prose and the agent's tools are pinned, not just the flags ──
# (the third review corrupted each of these in a copy and the checks still printed OK)

@test "orchestrator drift: the agent may have exactly these tools; any other (a tracker write tool, say) is caught" {
  corrupt "$(AGENT_COPY)" "tools: Read, Bash, Grep, Glob, Agent, AskUserQuestion" "tools: Read, Bash, Grep, Glob, Agent, AskUserQuestion, mcp__claude_ai_Atlassian__createJiraIssue"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "createJiraIssue" ]]
  [[ "$output" =~ "exactly" ]]
}

@test "orchestrator drift: a missing allowed tool is caught too (an agent that cannot run the scripts does nothing)" {
  corrupt "$(AGENT_COPY)" "tools: Read, Bash, Grep, Glob, Agent, AskUserQuestion" "tools: Read, Bash, Grep, Glob, Agent"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "AskUserQuestion" ]]
}

@test "orchestrator drift: the human gates in the step table and the closing rule are pinned" {
  corrupt "$(CMD_COPY)" '**only on their yes**' 'right away'
  orch_check; [ "$status" -eq 1 ]; [[ "$output" =~ "comment-existing" ]]; [[ "$output" =~ "only on their yes" ]]
  cp "$REPO_ROOT/.claude/commands/run-and-triage.md" "$(CMD_COPY)"
  corrupt "$(CMD_COPY)" 'File nothing and comment on nothing' 'File a regression bug'
  orch_check; [ "$status" -eq 1 ]; [[ "$output" =~ "report-dismissed" ]]
  cp "$REPO_ROOT/.claude/commands/run-and-triage.md" "$(CMD_COPY)"
  corrupt "$(CMD_COPY)" 'Nothing is filed, commented or edited without the human review gate.' 'Everything is filed automatically.'
  orch_check; [ "$status" -eq 1 ]; [[ "$output" =~ "human review gate" ]]
  cp "$REPO_ROOT/.claude/commands/run-and-triage.md" "$(CMD_COPY)"
  corrupt "$(CMD_COPY)" 'Never file it.' 'File it.'
  orch_check; [ "$status" -eq 1 ]; [[ "$output" =~ "Never file it" ]]
}

@test "orchestrator drift: the instruction not to widen the trusted formats is pinned (flipping it to 'Pass it' is caught)" {
  corrupt "$(CMD_COPY)" 'Do not pass `--trusted-formats`' 'Pass `--trusted-formats`'
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "not to pass --trusted-formats" ]]
}

@test "rubric drift: the never-file and never-close rules are pinned" {
  corrupt "$TEST_TMP/.claude/memory/failure-triage-rules.md" 'Never file a bug for `flaky`, `environment`, `test-bug` or `undetermined`.' 'Bugs are filed for everything.'
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "Never file a bug for" ]]
  cp "$REPO_ROOT/.claude/memory/failure-triage-rules.md" "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  corrupt "$TEST_TMP/.claude/memory/failure-triage-rules.md" 'Never close, reopen or re-prioritize an existing bug.' 'Reopen bugs freely.'
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "Never close, reopen" ]]
}

# ── whole-line pins: an exception appended to a rule, or a gate sentence flipped, is caught (the third review's re-run) ──
# Each corruption below printed OK against the first version of these checks, which only looked for a phrase being present.

FILEBUG_COPY() { echo "$TEST_TMP/.claude/commands/file-bug.md"; }
RUBRIC_COPY() { echo "$TEST_TMP/.claude/memory/failure-triage-rules.md"; }
pinned() { # <file> <from> <to> <expected text in the report>
  corrupt "$1" "$2" "$3"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "$4" ]]
}

@test "pins: an exception appended to the comment-existing row is caught" {
  pinned "$(CMD_COPY)" 'the action'"'"'s `commentInputFile`: the plan already wrote it, so you write nothing) |' 'the action'"'"'s `commentInputFile`: the plan already wrote it, so you write nothing), or automatically when the user ran with --yes |' "comment-existing"
}

@test "pins: the 'relay any approval request to the user and wait' sentence is caught when replaced" {
  pinned "$(CMD_COPY)" 'relay any approval request to the user and wait' "approve on the user's behalf" "relay any approval request"
}

@test "pins: the sentence that only product-bug verdicts reach file-bug is caught when removed or flipped" {
  pinned "$(CMD_COPY)" 'Only `product-bug` verdicts at or above the confidence threshold ever reach' 'Any verdict may reach' "Only \`product-bug\` verdicts at or above"
}

@test "pins: propose-test-fix saying 'Edit nothing' is caught when changed to a fix" {
  pinned "$(CMD_COPY)" '**Edit nothing**' 'Fix the stale selector in the page object' "propose-test-fix"
}

@test "pins: the production prohibition is caught when removed from the command, the agent or the rubric" {
  pinned "$(CMD_COPY)" 'Never capture from production.' '' "Never capture from production"
  cp "$REPO_ROOT/.claude/commands/run-and-triage.md" "$(CMD_COPY)"
  pinned "$(AGENT_COPY)" 'Never touch a production URL.' '' "Never touch a production URL"
  cp "$REPO_ROOT/.claude/agents/QA-run-orchestrator.md" "$(AGENT_COPY)"
  pinned "$(RUBRIC_COPY)" 'Never run anything against production' 'Run against production when sure' "Never run anything against production"
}

@test "pins: 'confirm the target environment with the engineer' is caught when removed" {
  pinned "$(CMD_COPY)" 'and confirm the target environment with the engineer before running anything.' 'and run.' "confirm the target environment"
}

@test "pins: 'never promote a propose' is caught when reversed" {
  pinned "$(CMD_COPY)" 'never promote a `propose` to an action.' 'may promote a `propose` when sure.' "never promote"
}

@test "pins: the agent's 'nothing from a failure goes on a command line' and 'only product-bug becomes a bug report' are caught when flipped" {
  pinned "$(AGENT_COPY)" '**Nothing from a failure goes on a command line.**' 'Paste failure text into commands freely.' "Nothing from a failure goes on a command line"
  cp "$REPO_ROOT/.claude/agents/QA-run-orchestrator.md" "$(AGENT_COPY)"
  pinned "$(AGENT_COPY)" 'Only `product-bug` verdicts ever become bug reports' 'Any verdict may become a bug report' "Only \`product-bug\` verdicts ever become"
}

@test "pins: the rubric's never-edit, never-present-a-propose, autonomy and only-product-bug sentences are caught when flipped" {
  pinned "$(RUBRIC_COPY)" 'Never edit a test, a page object, or the app as part of triage.' 'Edit tests as needed.' "Never edit a test"
  cp "$REPO_ROOT/.claude/memory/failure-triage-rules.md" "$(RUBRIC_COPY)"
  pinned "$(RUBRIC_COPY)" 'Never present a `propose` as a decision.' 'Present a propose as a decision.' "Never present"
  cp "$REPO_ROOT/.claude/memory/failure-triage-rules.md" "$(RUBRIC_COPY)"
  pinned "$(RUBRIC_COPY)" 'regardless of any autonomy setting' 'unless the autonomy setting says otherwise' "regardless of any autonomy"
  cp "$REPO_ROOT/.claude/memory/failure-triage-rules.md" "$(RUBRIC_COPY)"
  pinned "$(RUBRIC_COPY)" 'Only `product-bug` ever becomes a bug report.' 'Any class may become a bug report.' "Only \`product-bug\` ever becomes"
}

@test "pins: file-bug's 'do not file anything until they explicitly approve' is caught when removed" {
  pinned "$(FILEBUG_COPY)" 'Do NOT file anything until they explicitly approve.' 'File when ready.' "Do NOT file anything"
}

@test "pins: the agent's model and maxTurns frontmatter are caught when changed" {
  pinned "$(AGENT_COPY)" 'model: opus' 'model: haiku' "model: opus"
  cp "$REPO_ROOT/.claude/agents/QA-run-orchestrator.md" "$(AGENT_COPY)"
  pinned "$(AGENT_COPY)" 'maxTurns: 60' 'maxTurns: 600' "maxTurns: 60"
}

@test "pins: a changed row anywhere in the step table is caught, whichever step it is" {
  for step in file-bug file-regression report-flaky report-environment duplicate-in-run; do
    cp "$REPO_ROOT/.claude/commands/run-and-triage.md" "$(CMD_COPY)"
    node -e '
      const fs = require("fs"); const f = process.argv[1]; const step = process.argv[2];
      const lines = fs.readFileSync(f, "utf8").split("\n"); const i = lines.findIndex((l) => l.startsWith("| `" + step + "`"));
      if (i < 0) { console.error("no row " + step); process.exit(9); }
      lines[i] = lines[i].replace(/ \|$/, " (and do it without asking) |"); fs.writeFileSync(f, lines.join("\n"));' "$(CMD_COPY)" "$step"
    orch_check
    [ "$status" -eq 1 ]
    [[ "$output" =~ "$step" ]]
  done
}

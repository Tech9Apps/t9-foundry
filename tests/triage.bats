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
  cp "$REPO_ROOT/qa-config.schema.json" "$TEST_TMP/"   # the prose names config keys; the checks verify them against the schema
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

@test "the triage settings in qa-config.json: precedence, validation, and the schema agreeing with the loader" {
  run node_tests config.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "self-heal's pure core: id validation, locator patterns, the substitution guard, what may be edited" {
  run node_tests heal-core.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "self-heal end to end on real git repositories: heals, refuses, reverts, and never publishes" {
  run node_tests heal.test.js
  [ "$status" -eq 0 ]
  [[ "$output" =~ "# fail 0" ]]
}

@test "the triage scripts depend on nothing but Node built-ins" {
  mods=$(grep -rhoE "require\('[^']+'\)" "$REPO_ROOT/scripts/triage" | sed -E "s/require\('([^']+)'\)/\1/" | grep -v '^\.' | sort -u)
  for m in $mods; do
    case "$m" in fs|path|os|crypto|child_process) ;; *) echo "unexpected dependency: $m"; false ;; esac
  done
}

@test "classify.js, run as a real process on real demo output, proposes then acts as re-runs confirm" {
  cd "$REPO_ROOT"
  # hermetic: without --config the CLI discovers ./qa-config.json, which a developer may have set (triage.confidenceThreshold, trustedFormats…)
  echo '{}' > "$TEST_TMP/empty-config.json"
  node scripts/results/normalize.js tests/fixtures/results/node-test.tap --out "$TEST_TMP/run.json" >/dev/null
  run node scripts/triage/classify.js --run "$TEST_TMP/run.json" --config "$TEST_TMP/empty-config.json"
  [ "$status" -eq 0 ]
  [ "$(echo "$output" | jq -r '[.data.verdicts[] | "\(.rule):\(.action)"] | join(",")')" = "PRD-3:propose,PRD-3:propose" ]
  run node scripts/triage/classify.js --run "$TEST_TMP/run.json" --rerun "$TEST_TMP/run.json" --rerun "$TEST_TMP/run.json" --config "$TEST_TMP/empty-config.json"
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

@test "drift: an undetermined reason with a different confidence in the rubric is caught" {
  sed -i.bak 's#| `CONSISTENT_TIMEOUT` | 0.50 |#| `CONSISTENT_TIMEOUT` | 0.90 |#' "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "reason CONSISTENT_TIMEOUT has confidence 0.9 in the prose but 0.5 in the code" ]]
}

@test "drift: an undetermined reason dropped from the rubric, or invented in it, is caught (it is a closed list)" {
  grep -v '^| `UNSTABLE_ERRORS` ' "$TEST_TMP/.claude/memory/failure-triage-rules.md" > "$TEST_TMP/x" && mv "$TEST_TMP/x" "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "undetermined reason UNSTABLE_ERRORS, which the prose does not document" ]]
  cp "$REPO_ROOT/.claude/memory/failure-triage-rules.md" "$TEST_TMP/.claude/memory/"
  sed -i.bak 's#^| `UNCLASSIFIED` |#| `SOMETHING_ELSE` | 0.30 | made up |\n| `UNCLASSIFIED` |#' "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "SOMETHING_ELSE, which the code does not have" ]]
}

@test "drift: the rubric no longer saying an undetermined verdict never acts is caught" {
  sed -i.bak 's#never acts#sometimes acts#' "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no longer says an undetermined verdict never acts" ]]
}

@test "orchestrator drift: the command naming an undetermined reason the code does not have is caught" {
  sed -i.bak 's#`LOCATOR_NO_EVIDENCE`#`LOCATOR_UNKNOWN`#g; s#"LOCATOR_NO_EVIDENCE"#"LOCATOR_UNKNOWN"#g' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "LOCATOR_UNKNOWN, which the code does not have" ]]
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
  [[ "$output" =~ "pass --threshold / --trusted-formats on to classify.js" ]]
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

# ── self-heal: the claims that must not drift ─────────────────────────────────────

@test "drift: a self-heal cap stated in the rubric that is not the default is caught" {
  sed -i.bak 's#at most 5 files and 20 changed lines#at most 9 files and 20 changed lines#' "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "touches at most 9 files but the default cap is 5" ]]
}

@test "drift: the rubric no longer saying self-heal never pushes, or needs an explicit yes, is caught" {
  sed -i.bak 's#It never pushes#It rarely pushes#' "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no longer says self-heal never pushes" ]]
  cp "$REPO_ROOT/.claude/memory/failure-triage-rules.md" "$TEST_TMP/.claude/memory/"
  sed -i.bak 's#explicit yes#nod#g' "$TEST_TMP/.claude/memory/failure-triage-rules.md"
  run env DRIFT_ROOT="$TEST_TMP" node "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" =~ "never published without the user's explicit yes" ]]
}

@test "orchestrator drift: pushing a heal branch without tying it to the user's explicit yes is caught" {
  sed -i.bak 's#Only on their explicit yes#When convenient#' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no longer tied to \"Only on their explicit yes\"" ]]
}

@test "orchestrator drift: a heal status the table does not explain, or one that never happens, is caught" {
  grep -v '^| `reverted` ' "$(CMD_COPY)" > "$TEST_TMP/x" && mv "$TEST_TMP/x" "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "can end in \"reverted\" but the table does not explain it" ]]
  cp "$REPO_ROOT/.claude/commands/run-and-triage.md" "$(CMD_COPY)"
  sed -i.bak 's#^| `nothing-to-heal` |#| `partially-healed` | some of it | go on |\n| `nothing-to-heal` |#' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "documents \"partially-healed\", which a heal never ends in" ]]
}

@test "orchestrator drift: no longer telling the model not to retry or hand-edit a refused heal is caught" {
  sed -i.bak 's#Do not retry, and do not edit by hand#Try again#g' "$(CMD_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no longer tells the model not to retry or hand-edit" ]]
}

@test "orchestrator drift: the agent no longer saying a heal needs an explicit yes is caught" {
  sed -i.bak 's#explicit yes#nod#g' "$(AGENT_COPY)"
  orch_check
  [ "$status" -eq 1 ]
  [[ "$output" =~ "no longer says a heal is never published without the user's explicit yes" ]]
}

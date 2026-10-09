// .claude/commands/run-and-triage.md and .claude/agents/QA-run-orchestrator.md tell a model exactly how to drive
// scripts/triage/*. If the prose and the code drift apart, the model follows the prose and breaks. This checks:
//   - every `node scripts/<dir>/<script>.js …` line names a real script and only flags that script defines
//   - the step table lists exactly the steps plan.js can produce (STEPS), no more, no fewer
//   - the re-run default/range the prose states match orchestrate.js; the files it says are written, are
//   - the fingerprint marker the prose says to include is the one plan.js emits, and file-bug.md knows about it
//   - every file the prose points at exists
//   - the agent cannot edit files (no Edit/NotebookEdit tool), can delegate (Agent), and points at the command
// Prints "OK" or the list of problems (exit 1). DRIFT_ROOT lets the tests point it at a corrupted copy.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.env.DRIFT_ROOT || path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const problems = [];
const bad = (m) => problems.push(m);

const CMD = '.claude/commands/run-and-triage.md';
const AGENT = '.claude/agents/QA-run-orchestrator.md';
const cmd = read(CMD);
const agent = read(AGENT);
const { STEPS } = require(path.join(ROOT, 'scripts/triage/plan.js'));
const { MAX_RERUNS } = require(path.join(ROOT, 'scripts/triage/orchestrate.js'));

// ── scripts and flags ───────────────────────────────────────────────────────
const flagsIn = (src) => new Set([...src.matchAll(/flag === '(--[a-z-]+)'/g)].map((m) => m[1]).concat(['--help']));
const SCRIPTS = {};
cmd.split('\n').forEach((line, i) => {
  const m = line.match(/node (scripts\/(?:triage|tracker|results)\/[\w-]+\.js)(.*)$/);
  if (!m) return;
  const [, file, rest] = m;
  if (!exists(file)) { bad(`${CMD}:${i + 1}: ${file} does not exist`); return; }
  SCRIPTS[file] = SCRIPTS[file] || flagsIn(read(file));
  for (const f of rest.matchAll(/(?:^|\s)(--[a-z-]+)/g)) if (!SCRIPTS[file].has(f[1])) bad(`${CMD}:${i + 1}: ${path.basename(file)} has no option ${f[1]}`);
  if (file.endsWith('tracker/cli.js')) {
    const op = rest.trim().split(/\s+/)[0];
    const { OPERATIONS } = require(path.join(ROOT, 'scripts/tracker/lib/contract.js'));
    if (!OPERATIONS.includes(op)) bad(`${CMD}:${i + 1}: "cli.js ${op}" is not an operation`);
  }
});
// flags named in prose for orchestrate.js ("`--test-dir <…>`", "(`--reruns`, 0–5)") must exist there too
const orchFlags = flagsIn(read('scripts/triage/orchestrate.js'));
for (const m of cmd.matchAll(/`(--[a-z-]+)[ `]/g)) if (!orchFlags.has(m[1]) && !Object.values(SCRIPTS).some((set) => set.has(m[1]))) bad(`${CMD}: mentions ${m[1]}, which no script it calls defines`);
for (const need of ['orchestrate.js', 'classify.js', 'plan.js', 'locators.js']) if (!Object.keys(SCRIPTS).some((f) => f.endsWith(need))) bad(`${CMD}: no longer calls ${need}`);
if (!/bash scripts\/preflight\.sh/.test(cmd)) bad(`${CMD}: no longer runs scripts/preflight.sh`);
if (!exists('scripts/preflight.sh')) bad('scripts/preflight.sh does not exist');

// ── the step table ──────────────────────────────────────────────────────────
const section = cmd.slice(cmd.indexOf('## 4. Act on each step')).split('\n');
const head = section.findIndex((l) => /^\|\s*`step`\s*\|/.test(l));
if (head < 0) bad(`${CMD}: no step table (a table whose first column is "\`step\`")`);
const documented = [];
for (let i = head + 2; head >= 0 && i < section.length && section[i].startsWith('|'); i += 1) { // skip the header and the |---| row
  const m = section[i].match(/^\|\s*`([a-z-]+)`\s*\|/);
  if (m) documented.push(m[1]);
}
for (const s of STEPS) if (!documented.includes(s)) bad(`${CMD}: plan.js can produce the step "${s}" but the step table does not explain it`);
for (const s of documented) if (!STEPS.includes(s)) bad(`${CMD}: the step table documents "${s}", which plan.js never produces`);

// ── re-runs, outputs, marker ─────────────────────────────────────────────────
const orch = read('scripts/triage/orchestrate.js');
const stated = cmd.match(/\(`--reruns`,\s*(\d)[–-](\d)\)/);
const { DEFAULTS } = require(path.join(ROOT, 'scripts/triage/lib/config.js'));
const defaultCode = String(DEFAULTS.reruns);
if (!stated) bad(`${CMD}: does not state the re-run range ("(\`--reruns\`, 0–5)")`);
else if (Number(stated[2]) !== MAX_RERUNS || stated[1] !== '0') bad(`${CMD}: states re-runs ${stated[1]}–${stated[2]} but the code allows 0–${MAX_RERUNS}`);
const statedDefault = cmd.match(/Re-runs default to (\d)/);
if (!statedDefault) bad(`${CMD}: does not state the default number of re-runs`);
else if (statedDefault[1] !== defaultCode) bad(`${CMD}: says re-runs default to ${statedDefault[1]} but the code defaults to ${defaultCode}`);
// the config keys the prose names must exist in the schema, and the schema's defaults must be the code's
const schemaTriage = JSON.parse(read('qa-config.schema.json')).properties.triage;
for (const key of ['reruns', 'confidenceThreshold']) {
  if (!cmd.includes(`triage.${key}`)) bad(`${CMD}: no longer tells the model about triage.${key}`);
  if (!schemaTriage || !schemaTriage.properties[key]) bad(`${CMD} names triage.${key}, which qa-config.schema.json does not define`);
}
for (const f of ['triage.json', 'plan.json', 'flaky.json']) {
  if (!cmd.includes(f)) bad(`${CMD}: no longer mentions ${f}`);
  if (!orch.includes(f)) bad(`${CMD} says ${f} is written, but orchestrate.js does not write it`);
}
for (const d of ['main', 'rerun-']) if (!orch.includes(`'${d === 'main' ? 'main' : 'rerun-'}`) && !orch.includes(`\`${d}`)) bad(`orchestrate.js no longer writes the "${d}" result directories the prose reads`);
const marker = (read('scripts/triage/plan.js').match(/`(qa-harness-fingerprint):/) || [])[1];
if (!marker) bad('scripts/triage/plan.js no longer emits a "qa-harness-fingerprint:" marker');
else {
  if (!cmd.includes(`${marker}: <token>`)) bad(`${CMD}: does not tell the model to put "${marker}: <token>" in the bug body`);
  if (!read('.claude/commands/file-bug.md').includes(`${marker}: <token>`)) bad('.claude/commands/file-bug.md does not know about the fingerprint marker the orchestrator hands over');
}

// ── pointers ─────────────────────────────────────────────────────────────────
for (const f of ['.claude/memory/failure-triage-rules.md', '.claude/memory/ai-usage-rules.md', '.claude/skills/run-tests.md', '.claude/agents/Bug-reporter.md', '.claude/commands/file-bug.md']) {
  if (!exists(f)) bad(`a file the prose depends on is missing: ${f}`);
}
for (const f of ['.claude/memory/failure-triage-rules.md', '.claude/skills/run-tests.md', '.claude/agents/Bug-reporter.md']) if (!cmd.includes(f.replace(/^\.claude\/agents\//, '').replace(/\.md$/, '')) && !cmd.includes(f)) bad(`${CMD}: no longer points at ${f}`);
if (!/\*\*Bug-reporter\*\* agent/.test(cmd)) bad(`${CMD}: no longer delegates filing to the Bug-reporter agent`);

// ── the agent ────────────────────────────────────────────────────────────────
const fm = (agent.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
const tools = ((fm.match(/^tools:\s*(.*)$/m) || [])[1] || '').split(',').map((t) => t.trim());
if (!fm) bad(`${AGENT}: no frontmatter`);
if ((fm.match(/^name:\s*(.*)$/m) || [])[1] !== 'QA-run-orchestrator') bad(`${AGENT}: name must be QA-run-orchestrator`);
for (const forbidden of ['Edit', 'NotebookEdit']) if (tools.includes(forbidden)) bad(`${AGENT}: has the ${forbidden} tool — the orchestrator must not be able to edit files (self-heal is not enabled)`);
if (!tools.includes('Agent')) bad(`${AGENT}: needs the Agent tool to hand bugs to Bug-reporter`);
if (!tools.includes('Bash')) bad(`${AGENT}: needs Bash to run the scripts`);
if (!agent.includes('.claude/commands/run-and-triage.md')) bad(`${AGENT}: does not point at .claude/commands/run-and-triage.md`);
for (const c of [...cmd.matchAll(/`(\*\*✅ [^`]+\*\*)`/g)].map((m) => m[1])) if (!/^\*\*✅ .+\*\*$/.test(c)) bad(`${CMD}: malformed checkpoint ${c}`);
if (![...cmd.matchAll(/`\*\*✅ [^`]+\*\*`/g)].length) bad(`${CMD}: no checkpoint lines`);

if (problems.length) { console.log(`${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`); process.exit(1); }
console.log('OK');

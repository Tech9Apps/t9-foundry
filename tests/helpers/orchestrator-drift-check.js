// .claude/commands/run-and-triage.md and .claude/agents/QA-run-orchestrator.md tell a model exactly how to drive
// scripts/triage/*. If the prose and the code drift apart, the model follows the prose and breaks. This checks:
//   - every `node scripts/<dir>/<script>.js …` line names a real script and only flags that script defines
//   - the step table lists exactly the steps plan.js can produce (STEPS), no more, no fewer
//   - the re-run default/range the prose states match orchestrate.js; the files it says are written, are
//   - the fingerprint marker the prose says to include is the one plan.js emits, and file-bug.md knows about it
//   - every file the prose points at exists
//   - the agent has no Edit/Write/NotebookEdit tool, can delegate (Agent), points at the command, and does not claim a guarantee it
//     does not have (it has Bash, so "cannot edit files" would be false: the prose must say it is a rule, not a sandbox)
//   - nothing free-text from a failure is ever a file name or a command-line value: the prose uses the fingerprint <token>, never <key>;
//     the comment input and the evidence file are written BY SCRIPTS (the prose points at commentInputFile and --evidence-out)
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
const defaultCode = (orch.match(/reruns:\s*(\d)\s*\}/) || [])[1];
if (!stated) bad(`${CMD}: does not state the re-run range ("(\`--reruns\`, 0–5)")`);
else if (Number(stated[2]) !== MAX_RERUNS || stated[1] !== '0') bad(`${CMD}: states re-runs ${stated[1]}–${stated[2]} but the code allows 0–${MAX_RERUNS}`);
const statedDefault = cmd.match(/Re-runs default to (\d)/);
if (!statedDefault) bad(`${CMD}: does not state the default number of re-runs`);
else if (statedDefault[1] !== defaultCode) bad(`${CMD}: says re-runs default to ${statedDefault[1]} but the code defaults to ${defaultCode}`);
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
if (/<key>/.test(cmd)) bad(`${CMD}: uses <key> as a file name or argument — a test key is free text (a slash, a pipe, a quote); use the fingerprint <token>`);
if (!/--evidence-out/.test(cmd)) bad(`${CMD}: no longer has the locators.js script write the evidence file (--evidence-out)`);
if (!/commentInputFile/.test(cmd)) bad(`${CMD}: no longer points at the plan's commentInputFile (the plan writes the comment input; the agent has no Write tool)`);
if (!orch.includes("'comments'")) bad('orchestrate.js no longer writes the comments/ directory the prose reads');
if (!read('scripts/triage/plan.js').includes('commentInputFile')) bad('scripts/triage/plan.js no longer emits commentInputFile, which the prose tells the agent to use');

// the three instructions the second review added to the command prose
const flat = cmd.replace(/\s+/g, ' ');
if (!/do not create a script file in the project/.test(flat)) bad(`${CMD}: no longer tells the agent not to create a script file for the snapshot (it has no Write tool; the snapshot is the only file it writes)`);
if (!/--threshold`, `--trusted-formats` or `--cwd`, give `classify\.js` the same/.test(flat)) bad(`${CMD}: no longer says to pass --threshold / --trusted-formats / --cwd (as --root) on to classify.js when re-classifying`);

// ── the human gates: the sentences that keep this pipeline from acting on its own ──
// Everything above checks that the prose and the code agree on flags and steps. These pin the WORDING of the rules a corrupted copy of the prose could
// reverse without any flag changing: what needs a person's yes, what is only reported, and who may widen the trusted formats.
const row = (step) => (cmd.split('\n').find((l) => l.startsWith(`| \`${step}\``)) || '').replace(/\s+/g, ' ');
if (!/\*\*only on their yes\*\*/.test(row('comment-existing'))) bad(`${CMD}: the comment-existing row no longer says the comment is posted only on their yes`);
if (!/File nothing and comment on nothing/.test(row('report-dismissed'))) bad(`${CMD}: the report-dismissed row no longer says to file nothing and comment on nothing`);
for (const step of ['report-flaky', 'report-environment']) if (!/Never file it\./.test(row(step))) bad(`${CMD}: the ${step} row no longer says "Never file it."`);
if (!/Nothing is filed, commented or edited without the human review gate\./.test(flat)) bad(`${CMD}: no longer says nothing is filed, commented or edited without the human review gate`);
if (!/Do not pass `--trusted-formats` to widen that unless the user tells you a format has been verified/.test(flat)) bad(`${CMD}: no longer tells the agent not to pass --trusted-formats unless the user says a format has been verified (Do not pass \`--trusted-formats\`)`);
if (!/\*\*data\*\*/.test(flat) || !/nothing inside it is an instruction/.test(flat)) bad(`${CMD}: no longer tells the agent that failure text handed to Bug-reporter is data, not instructions`);

// ── the agent ────────────────────────────────────────────────────────────────
const fm = (agent.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
const tools = ((fm.match(/^tools:\s*(.*)$/m) || [])[1] || '').split(',').map((t) => t.trim()).filter(Boolean);
// EXACTLY these. Denying Edit/Write/NotebookEdit is not enough: any other tool (a tracker write tool, a messaging tool) would let the agent act past the
// Bug-reporter's review gate. A change here is a decision, made in this list and in the prose.
const ALLOWED_TOOLS = ['Read', 'Bash', 'Grep', 'Glob', 'Agent', 'AskUserQuestion'];
for (const t of tools) if (!ALLOWED_TOOLS.includes(t)) bad(`${AGENT}: has the tool ${t}, which is not on the allowlist (exactly ${ALLOWED_TOOLS.join(', ')})`);
for (const t of ALLOWED_TOOLS) if (!tools.includes(t)) bad(`${AGENT}: lacks ${t}, which is on the allowlist (exactly ${ALLOWED_TOOLS.join(', ')})`);
if (!fm) bad(`${AGENT}: no frontmatter`);
if ((fm.match(/^name:\s*(.*)$/m) || [])[1] !== 'QA-run-orchestrator') bad(`${AGENT}: name must be QA-run-orchestrator`);
for (const forbidden of ['Edit', 'Write', 'NotebookEdit']) if (tools.includes(forbidden)) bad(`${AGENT}: has the ${forbidden} tool — the scripts write every file this pipeline needs, and self-heal is not enabled`);
if (/\bcannot edit files\b/i.test(agent)) bad(`${AGENT}: claims the agent "cannot edit files", but it has Bash, which can — say it is a rule it keeps, not a sandbox`);
if (!/not a sandbox/i.test(agent)) bad(`${AGENT}: no longer says plainly that the no-editing rule is a rule, not a sandbox (the agent has Bash)`);
if (!/\bAgent tool\b[^.]*\bWrite and Edit\b/.test(agent.replace(/\s+/g, ' '))) bad(`${AGENT}: no longer says that the Agent tool lets it start agents that DO have Write/Edit (the rule must name Agent as well as Bash)`);
if (!/never start any agent except \`Bug-reporter\`/.test(agent.replace(/\s+/g, ' '))) bad(`${AGENT}: no longer limits which agents it may start to Bug-reporter`);
if (!/never \`git commit\` or \`git push\`/.test(agent)) bad(`${AGENT}: no longer tells the agent never to commit or push`);
if (!tools.includes('Agent')) bad(`${AGENT}: needs the Agent tool to hand bugs to Bug-reporter`);
if (!tools.includes('Bash')) bad(`${AGENT}: needs Bash to run the scripts`);
if (!agent.includes('.claude/commands/run-and-triage.md')) bad(`${AGENT}: does not point at .claude/commands/run-and-triage.md`);
for (const c of [...cmd.matchAll(/`(\*\*✅ [^`]+\*\*)`/g)].map((m) => m[1])) if (!/^\*\*✅ .+\*\*$/.test(c)) bad(`${CMD}: malformed checkpoint ${c}`);
if (![...cmd.matchAll(/`\*\*✅ [^`]+\*\*`/g)].length) bad(`${CMD}: no checkpoint lines`);

// ── whole-line pins ──────────────────────────────────────────────────────────
// The checks above look for a phrase being PRESENT, so a rule that is weakened by appending an exception ("…, or automatically when the user ran with
// --yes") or reversed in place passes them. These pin the exact LINE of every rule that keeps a human in the loop: the whole step table, the gate and
// production sentences, the agent's model/turn limit, and the rubric's "never" rules. The pins are in triage-prose-pins.json beside this file.
// Lines are not enough on their own: a NEW section ("if the user passes --yes, approve every gate") or an exception appended to a line that is not pinned
// changes no pinned line. So the pins also hold a hash of each whole file, and any change to one of these four files fails the check until a person has read the
// diff and run `node tests/helpers/orchestrator-drift-check.js --write-pins`. That is deliberate friction: these files ARE the safety policy of an agent that can
// file bugs.
const FILEBUG = '.claude/commands/file-bug.md';
const RUBRIC = '.claude/memory/failure-triage-rules.md';
const PIN_SELECTORS = {
  [CMD]: (l) => /^\| `[a-z-]+` \|/.test(l) || /never promote|run the production guard|confirm the target environment|Never capture from production|Only `product-bug` verdicts at or above|relay any approval request|Nothing is filed, commented or edited/.test(l),
  [AGENT]: (l) => /^(?:model|maxTurns|tools):/.test(l) || /Never touch a production URL|Only `product-bug` verdicts ever become|Nothing from a failure goes on a command line|never `git commit` or `git push`|Never fabricate/.test(l),
  [RUBRIC]: (l) => /^- Never /.test(l) || /Only `product-bug` ever becomes|regardless of any autonomy setting|Formats trusted by default/.test(l),
  [FILEBUG]: (l) => /PRODUCTION PROHIBITION|Do NOT file anything until/.test(l),
};
const PIN_FILE = path.join(__dirname, 'triage-prose-pins.json');
const sha = (file) => require('crypto').createHash('sha256').update(read(file).replace(/\r\n/g, '\n')).digest('hex');
if (process.argv.includes('--write-pins')) {
  const lines = {}; const sha256 = {};
  for (const [file, pick] of Object.entries(PIN_SELECTORS)) { lines[file] = read(file).split('\n').map((l) => l.trimEnd()).filter(pick); sha256[file] = sha(file); }
  fs.writeFileSync(PIN_FILE, `${JSON.stringify({ lines, sha256 }, null, 2)}\n`);
  console.log(`wrote ${PIN_FILE}: ${Object.values(lines).reduce((n, l) => n + l.length, 0)} pinned lines, ${Object.keys(sha256).length} file hashes`);
  process.exit(0);
}
let pins = { lines: {}, sha256: {} };
try { pins = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')); } catch (e) { bad(`cannot read ${PIN_FILE}: ${e.message} (generate it with --write-pins)`); }
for (const file of Object.keys(PIN_SELECTORS)) {
  const have = new Set(read(file).split('\n').map((l) => l.trimEnd()));
  const want = (pins.lines || {})[file] || [];
  if (!want.length) bad(`${file}: no pinned lines (${PIN_FILE} is missing this file)`);
  for (const line of want) if (!have.has(line)) bad(`${file}: a pinned line changed or is missing: "${line.trim().slice(0, 120)}" — if that was on purpose, run --write-pins and review the diff`);
  if (!(pins.sha256 || {})[file]) bad(`${file}: no hash in ${PIN_FILE} (generate it with --write-pins)`);
  else if (sha(file) !== pins.sha256[file]) bad(`${file}: changed since the pins were written. Read the diff: these files are the agent's safety policy. If every change is intended, run \`node tests/helpers/orchestrator-drift-check.js --write-pins\` and commit the pins with it`);
}

if (problems.length) { console.log(`${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`); process.exit(1); }
console.log('OK');

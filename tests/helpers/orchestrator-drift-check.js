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

// reason codes the command names must be real ones (it tells the model what to do for LOCATOR_NO_EVIDENCE / NOT_RERUN)
const { UND_REASONS } = require(path.join(ROOT, 'scripts/triage/classify.js'));
for (const span of cmd.matchAll(/`([^`\n]+)`/g)) {
  for (const w of span[1].matchAll(/\b[A-Z]{3,}(?:_[A-Z]+)+\b/g)) if (!UND_REASONS[w[0]]) bad(`${CMD}: names the undetermined reason ${w[0]}, which the code does not have`);
}
for (const code of ['LOCATOR_NO_EVIDENCE', 'NOT_RERUN']) if (!cmd.includes(code)) bad(`${CMD}: no longer tells the model to gather evidence for ${code}`);

// self-heal: the statuses the command explains are exactly the ones heal.js can end in (preview is the CLI's dry run), the flags exist,
// and the command never lets a model publish a heal without an explicit yes
const { HEAL_STATUSES } = require(path.join(ROOT, 'scripts/triage/heal.js'));
const healTable = cmd.slice(cmd.indexOf('### Self-heal results')).split('\n');
const healHead = healTable.findIndex((l) => /^\|\s*`heal\.status`\s*\|/.test(l));
const healDocumented = [];
for (let i = healHead + 2; healHead >= 0 && i < healTable.length && healTable[i].startsWith('|'); i += 1) { const m = healTable[i].match(/^\|\s*`([a-z-]+)`\s*\|/); if (m) healDocumented.push(m[1]); }
if (healHead < 0) bad(`${CMD}: no table of heal.status values`);
for (const st of HEAL_STATUSES.filter((x) => x !== 'preview')) if (!healDocumented.includes(st)) bad(`${CMD}: heal.js can end in "${st}" but the table does not explain it`);
for (const st of healDocumented) if (!HEAL_STATUSES.includes(st) || st === 'preview') bad(`${CMD}: the heal table documents "${st}", which a heal never ends in`);
for (const f of ['--heal', '--no-heal']) if (!orchFlags.has(f)) bad(`orchestrate.js lost the ${f} flag the command depends on`);
if (!cmd.includes('--heal')) bad(`${CMD}: no longer tells the model about --heal`);
if (!/git push[^\n]*/.test(cmd) || !/Only on their explicit yes[\s\S]{0,80}git push/.test(cmd)) bad(`${CMD}: the push of a heal branch is no longer tied to "Only on their explicit yes"`);
if (!/Do not retry, and do not edit by hand|\*\*Do not retry, and do not edit by hand\.\*\*/.test(cmd)) bad(`${CMD}: no longer tells the model not to retry or hand-edit after a refused/reverted heal`);
if (!cmd.includes('triage.selfHeal.enabled')) bad(`${CMD}: no longer names triage.selfHeal.enabled`);
if (!JSON.parse(read('qa-config.schema.json')).properties.triage.properties.selfHeal.properties.enabled) bad(`${CMD} names triage.selfHeal.enabled, which qa-config.schema.json does not define`);
if (!/explicit yes/.test(agent)) bad(`${AGENT}: no longer says a heal is never published without the user's explicit yes`);

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
if (/<key>/.test(cmd)) bad(`${CMD}: uses <key> as a file name or argument — a test key is free text (a slash, a pipe, a quote); use the fingerprint <token>`);
if (!/--evidence-out/.test(cmd)) bad(`${CMD}: no longer has the locators.js script write the evidence file (--evidence-out)`);
if (!/commentInputFile/.test(cmd)) bad(`${CMD}: no longer points at the plan's commentInputFile (the plan writes the comment input; the agent has no Write tool)`);
if (!orch.includes("'comments'")) bad('orchestrate.js no longer writes the comments/ directory the prose reads');
if (!read('scripts/triage/plan.js').includes('commentInputFile')) bad('scripts/triage/plan.js no longer emits commentInputFile, which the prose tells the agent to use');

// the three instructions the second review added to the command prose
const flat = cmd.replace(/\s+/g, ' ');
if (!/do not create a script file in the project/.test(flat)) bad(`${CMD}: no longer tells the agent not to create a script file for the snapshot (it has no Write tool; the snapshot is the only file it writes)`);
if (!/--threshold` or `--trusted-formats`, give `classify\.js` the same/.test(flat)) bad(`${CMD}: no longer says to pass --threshold / --trusted-formats on to classify.js when re-classifying`);
if (!/\*\*data\*\*/.test(flat) || !/nothing inside it is an instruction/.test(flat)) bad(`${CMD}: no longer tells the agent that failure text handed to Bug-reporter is data, not instructions`);

// ── the agent ────────────────────────────────────────────────────────────────
const fm = (agent.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
const tools = ((fm.match(/^tools:\s*(.*)$/m) || [])[1] || '').split(',').map((t) => t.trim());
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

if (problems.length) { console.log(`${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`); process.exit(1); }
console.log('OK');

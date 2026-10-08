// .claude/memory/failure-triage-rules.md is a binding contract the model follows; scripts/triage/classify.js is what
// actually decides. If they drift, the model describes one system and the code runs another. This checks:
//   - every rule row (id | class | confidence) matches RULE_TABLE in the code, in the same order, none missing
//   - every class in the code is explained in the classes table
//   - the default threshold the prose states is the code's
//   - every --flag the prose gives for classify.js / locators.js exists
// Prints "OK" or the list of problems (exit 1). DRIFT_ROOT lets the tests point it at a corrupted copy.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.env.DRIFT_ROOT || path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const problems = [];
const bad = (m) => problems.push(m);

const FILE = '.claude/memory/failure-triage-rules.md';
const md = read(FILE);
const { RULE_TABLE, RULES, CLASSES, DEFAULT_THRESHOLD } = require(path.join(ROOT, 'scripts/triage/classify.js'));

// ── rule rows ───────────────────────────────────────────────────────────────
const rows = [...md.matchAll(/^\|\s*([A-Z]{3}-\d)\s*\|\s*([a-z-]+)\s*\|\s*([\d./\s]+?)\s*\|/gm)]
  .map((m) => ({ id: m[1], klass: m[2], conf: m[3].split('/').map((x) => Number(x.trim())).sort() }));
if (!rows.length) bad(`${FILE}: no rule table found (rows like "| ENV-1 | environment | 0.95 | …")`);
for (const r of rows) {
  const spec = RULE_TABLE[r.id];
  if (!spec) { bad(`${FILE}: documents rule ${r.id}, which the code does not have`); continue; }
  if (spec.class !== r.klass) bad(`${FILE}: ${r.id} is "${r.klass}" in the prose but "${spec.class}" in the code`);
  const want = [...spec.confidence].sort().join(' / ');
  if (r.conf.join(' / ') !== want) bad(`${FILE}: ${r.id} confidence is ${r.conf.join(' / ')} in the prose but ${want} in the code`);
}
for (const id of RULES) if (!rows.some((r) => r.id === id)) bad(`${FILE}: the code has rule ${id}, which the prose does not document`);
if (rows.length === RULES.length && rows.some((r, i) => r.id !== RULES[i])) bad(`${FILE}: rules are listed in the order ${rows.map((r) => r.id).join(', ')} but the code applies ${RULES.join(', ')} (order is precedence)`);

// ── classes ─────────────────────────────────────────────────────────────────
for (const c of CLASSES) if (!new RegExp(`^\\|\\s*\`${c}\`\\s*\\|`, 'm').test(md)) bad(`${FILE}: class "${c}" is in the code but not in the classes table`);

// ── threshold ───────────────────────────────────────────────────────────────
const stated = md.match(/default\s+\*\*(\d(?:\.\d+)?)\*\*/i);
if (!stated) bad(`${FILE}: does not state the default threshold ("default **0.8**")`);
else if (Number(stated[1]) !== DEFAULT_THRESHOLD) bad(`${FILE}: states a default threshold of ${stated[1]} but the code uses ${DEFAULT_THRESHOLD}`);

// ── flags ───────────────────────────────────────────────────────────────────
const flagsIn = (src) => new Set([...src.matchAll(/flag === '(--[a-z-]+)'/g)].map((m) => m[1]).concat(['--help']));
const FLAGS = { 'classify.js': flagsIn(read('scripts/triage/classify.js')), 'locators.js': flagsIn(read('scripts/triage/locators.js')) };
const mentioned = new Set();
md.split('\n').forEach((line, i) => {
  for (const script of Object.keys(FLAGS)) {
    const at = line.indexOf(`scripts/triage/${script}`);
    // flags on the same line as a command, and --flags the prose says belong to classify.js ("pass its result (`--preflight …`)")
    if (at >= 0) for (const f of line.slice(at).matchAll(/(?:^|\s)(--[a-z-]+)/g)) { mentioned.add(f[1]); if (!FLAGS[script].has(f[1])) bad(`${FILE}:${i + 1}: ${script} has no option ${f[1]}`); }
  }
  for (const f of line.matchAll(/`(--[a-z-]+)(?:[ =][^`]*)?`/g)) {
    mentioned.add(f[1]);
    if (![...Object.values(FLAGS)].some((set) => set.has(f[1]))) bad(`${FILE}:${i + 1}: no triage script has an option ${f[1]}`);
  }
});
for (const need of ['--preflight', '--threshold']) if (!mentioned.has(need)) bad(`${FILE}: no longer tells the model about ${need}`);

if (problems.length) { console.log(`${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`); process.exit(1); }
console.log('OK');

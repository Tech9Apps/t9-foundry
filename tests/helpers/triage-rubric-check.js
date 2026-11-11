// .claude/memory/failure-triage-rules.md is a binding contract the model follows; scripts/triage/classify.js is what
// actually decides. If they drift, the model describes one system and the code runs another. This checks:
//   - every rule row (id | class | confidence) matches RULE_TABLE in the code, in the same order, none missing
//   - every class in the code is explained in the classes table, and the undetermined REASONS table is exactly the code's
//     (codes and confidences) — undetermined is a closed list, not a free-text escape hatch
//   - the default threshold the prose states is the code's, and so are the runner formats it says are trusted by default
//   - every --flag the prose gives for classify.js / locators.js / orchestrate.js exists, and the qa-config.json keys it names are in the schema
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
const { RULE_TABLE, RULES, CLASSES, UND_REASONS, DEFAULT_THRESHOLD, DEFAULT_TRUSTED_FORMATS } = require(path.join(ROOT, 'scripts/triage/classify.js'));

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

// ── undetermined reasons: the closed list, with the confidences ───────────────────────────
const reasonRows = [...md.matchAll(/^\|\s*`([A-Z][A-Z_]+)`\s*\|\s*([\d.]+)\s*\|/gm)].map((m) => ({ code: m[1], conf: Number(m[2]) }));
if (!reasonRows.length) bad(`${FILE}: no table of undetermined reasons (rows like "| \`LOCATOR_NO_EVIDENCE\` | 0.40 | …")`);
for (const r of reasonRows) {
  if (!UND_REASONS[r.code]) bad(`${FILE}: documents the undetermined reason ${r.code}, which the code does not have`);
  else if (UND_REASONS[r.code].confidence !== r.conf) bad(`${FILE}: reason ${r.code} has confidence ${r.conf} in the prose but ${UND_REASONS[r.code].confidence} in the code`);
}
for (const code of Object.keys(UND_REASONS)) if (!reasonRows.some((r) => r.code === code)) bad(`${FILE}: the code has the undetermined reason ${code}, which the prose does not document`);
if (!/never acts/i.test(md)) bad(`${FILE}: no longer says an undetermined verdict never acts`);

// ── self-heal: the guarantees the prose states are the ones the config enforces ──────────────────
{
  const { DEFAULTS } = require(path.join(ROOT, 'scripts/triage/lib/config.js'));
  const sh = md.slice(md.indexOf('## Self-heal'));
  const caps = sh.match(/at most (\d+) files and (\d+) changed lines/);
  if (!caps) bad(`${FILE}: no longer states the self-heal caps ("at most N files and M changed lines")`);
  else {
    if (Number(caps[1]) !== DEFAULTS.selfHeal.maxFiles) bad(`${FILE}: says self-heal touches at most ${caps[1]} files but the default cap is ${DEFAULTS.selfHeal.maxFiles}`);
    if (Number(caps[2]) !== DEFAULTS.selfHeal.maxLines) bad(`${FILE}: says self-heal changes at most ${caps[2]} lines but the default cap is ${DEFAULTS.selfHeal.maxLines}`);
  }
  if (!sh.includes(`\`${DEFAULTS.selfHeal.branchPrefix}`)) bad(`${FILE}: no longer names the heal branch prefix ${DEFAULTS.selfHeal.branchPrefix}`);
  if (!/It never pushes/.test(sh)) bad(`${FILE}: no longer says self-heal never pushes`);
  if (!/explicit yes/.test(md)) bad(`${FILE}: no longer says a heal is never published without the user's explicit yes`);
  for (const key of ['triage.selfHeal.enabled', 'triage.selfHeal.paths', 'triage.selfHeal.maxFiles', 'triage.selfHeal.maxLines']) {
    const leaf = key.split('.').pop();
    if (!sh.includes(key) && !sh.includes(leaf)) bad(`${FILE}: no longer mentions ${key}`);
    if (!JSON.parse(read('qa-config.schema.json')).properties.triage.properties.selfHeal.properties[leaf]) bad(`${FILE} names ${key}, which qa-config.schema.json does not define`);
  }
}

// ── classes ─────────────────────────────────────────────────────────────────
for (const c of CLASSES) if (!new RegExp(`^\\|\\s*\`${c}\`\\s*\\|`, 'm').test(md)) bad(`${FILE}: class "${c}" is in the code but not in the classes table`);

// ── threshold ───────────────────────────────────────────────────────────────
const stated = md.match(/default\s+\*\*(\d(?:\.\d+)?)\*\*/i);
if (!stated) bad(`${FILE}: does not state the default threshold ("default **0.8**")`);
else if (Number(stated[1]) !== DEFAULT_THRESHOLD) bad(`${FILE}: states a default threshold of ${stated[1]} but the code uses ${DEFAULT_THRESHOLD}`);

// ── trusted formats ─────────────────────────────────────────────────────────
const trusted = md.match(/trusted by default:\s*\*\*([^*]+)\*\*/i);
if (!trusted) bad(`${FILE}: does not state which runner formats are trusted by default ("Formats trusted by default: **tap**")`);
else if (trusted[1].split(/[,\s]+/).filter(Boolean).sort().join(',') !== [...DEFAULT_TRUSTED_FORMATS].sort().join(',')) bad(`${FILE}: says "${trusted[1]}" is trusted by default but the code trusts ${DEFAULT_TRUSTED_FORMATS.join(', ')}`);
if (!/\bcap: unverified-format\b/.test(md)) bad(`${FILE}: no longer explains the \`cap: unverified-format\` marker`);

// ── flags ───────────────────────────────────────────────────────────────────
const flagsIn = (src) => new Set([...src.matchAll(/flag === '(--[a-z-]+)'/g)].map((m) => m[1]).concat(['--help']));
const FLAGS = { 'classify.js': flagsIn(read('scripts/triage/classify.js')), 'locators.js': flagsIn(read('scripts/triage/locators.js')), 'orchestrate.js': flagsIn(read('scripts/triage/orchestrate.js')), 'heal.js': flagsIn(read('scripts/triage/heal.js')) };
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
// the rules a corrupted copy could reverse without touching a rule row
const flatMd = md.replace(/\s+/g, ' ');
for (const sentence of ['Never file a bug for `flaky`, `environment`, `test-bug` or `undetermined`.', 'Never close, reopen or re-prioritize an existing bug.']) {
  if (!flatMd.includes(sentence)) bad(`${FILE}: no longer says "${sentence}"`);
}
if (!/the plan says `report-dismissed`: file nothing and\s+comment on nothing/.test(md)) bad(`${FILE}: no longer says a dismissed match means report-dismissed: file nothing and comment on nothing`);
for (const need of ['--preflight', '--threshold', '--trusted-formats']) if (!mentioned.has(need)) bad(`${FILE}: no longer tells the model about ${need}`);
const schemaTriage = JSON.parse(read('qa-config.schema.json')).properties.triage;
for (const key of ['confidenceThreshold', 'reruns', 'trustedFormats']) {
  if (!md.includes(`triage.${key}`)) bad(`${FILE}: no longer mentions the config key triage.${key}`);
  if (!schemaTriage || !schemaTriage.properties[key]) bad(`${FILE} names triage.${key}, which qa-config.schema.json does not define`);
}

if (problems.length) { console.log(`${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`); process.exit(1); }
console.log('OK');

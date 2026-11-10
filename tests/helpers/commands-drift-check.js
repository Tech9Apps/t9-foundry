// The command prompts tell a model exactly how to call the tracker CLIs. If the prose and the code
// drift apart, the model follows the prose and breaks. This checks every claim the prose makes:
//   - every `cli.js <op>` names a real operation
//   - every --flag on a cli.js / post-tests.js line is a flag that script really defines
//   - every example --input '{…}' and every JSON example the prose tells a model to write validates
//     against schemas/tracker-inputs.schema.json (with <placeholders> filled in)
//   - no direct API calls (curl, gh issue, vendor hostnames) remain for adapter-backed sources
//   - every registered adapter is named in each command's adapter section
//   - run-spec-tests.md: every scripts/results/run.js flag and --framework it names exists, and every
//     `totals.*` / `error.*` field it tells the model to read is in schemas/run-result.schema.json
//   - file-bug.md's receipt example validates against schemas/bug-receipt.schema.json, and its tracker list
//     is exactly the schema's
//   - a command split over backslash-continued lines is checked as ONE command (so a flag on line 2 is not missed)
//   - an inline --input '{…}' may not contain $VARS or <placeholders>: text from a ticket/failure/user must never be
//     pasted into a shell string (a quote in it would end the string) — it goes in a file written with the Write tool
//   - any command file that puts $ARGUMENTS on a shell line must state an anchored allow-list (^[…]…$) for it
// Prints "OK" or the list of problems (exit 1).
'use strict';
const fs = require('fs');
const path = require('path');
const Ajv = require(path.join(__dirname, '..', 'node_modules', 'ajv'));

const ROOT = process.env.DRIFT_ROOT || path.join(__dirname, '..', '..'); // override: used by the tests to prove corrupted prose is caught
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const problems = [];
const bad = (msg) => problems.push(msg);

const FILES = {
  fetch: '.claude/commands/fetch-ticket.md',
  post: '.claude/commands/post-tests.md',
  bug: '.claude/commands/file-bug.md',
  agent: '.claude/agents/Manual-Automation-test-generator.md',
};

// ── what the code really supports ─────────────────────────────────────────────
const flagsIn = (src) => new Set([...src.matchAll(/flag === '(--[a-z-]+)'/g)].map((m) => m[1]).concat(['--help']));
const cliSrc = read('scripts/tracker/cli.js');
const postSrc = read('scripts/tracker/post-tests.js');
const FLAGS = { 'cli.js': flagsIn(cliSrc), 'post-tests.js': flagsIn(postSrc) };
const OPS = new Set(require(path.join(ROOT, 'scripts/tracker/lib/contract.js')).OPERATIONS);
const registry = read('scripts/tracker/adapters/index.js');
const SUPPORTED = [...registry.match(/const ADAPTERS = \{([\s\S]*?)\n\};/)[1].matchAll(/^\s+([a-z]+):/gm)].map((m) => m[1]);

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(JSON.parse(read('schemas/tracker-inputs.schema.json')));
const validateInput = (op, obj, where) => {
  const v = ajv.compile({ $ref: `tracker-inputs.schema.json#/definitions/${op}` });
  if (!v(obj)) bad(`${where}: example ${op} input is invalid — ${ajv.errorsText(v.errors)} — ${JSON.stringify(obj)}`);
};
// "<anything>" and $VARS inside example JSON become a plain token so the example can be parsed/validated
const fill = (s) => s.replace(/<[^>\n]+>/g, 'x').replace(/\$ARGUMENTS/g, '1').replace(/\{testCasesDir\}/g, 'out');

// ── receipts ────────────────────────────────────────────────────────────────────
const receiptSchema = JSON.parse(read('schemas/bug-receipt.schema.json'));
const validateReceipt = ajv.compile(receiptSchema);
function checkReceipt(example, md, file) {
  // the prose shows the trackers as "a|b|c": that list must be exactly the schema's, in any order
  const listed = (example.trackerType || '').split('|').sort().join('|');
  const allowed = [...receiptSchema.properties.trackerType.enum].sort().join('|');
  if (listed !== allowed) bad(`${file}: receipt example lists trackers "${listed}" but the schema allows "${allowed}"`);
  const filled = { ...example, trackerType: receiptSchema.properties.trackerType.enum[0] };
  if (!validateReceipt(filled)) bad(`${file}: receipt example is invalid — ${ajv.errorsText(validateReceipt.errors)}`);
}

// a command split with trailing backslashes is one command: join the pieces, keep the first line's number
const logicalLines = (md) => {
  const out = []; const raw = md.split('\n');
  for (let i = 0; i < raw.length; i++) {
    let text = raw[i]; const start = i;
    while (/\\\s*$/.test(text) && i + 1 < raw.length) text = text.replace(/\\\s*$/, ' ') + raw[++i].trim();
    out.push({ text, n: start + 1 });
  }
  return out;
};

for (const [name, file] of Object.entries(FILES)) {
  const md = read(file);

  // 1+2. operations and flags
  logicalLines(md).forEach(({ text: line, n }) => {
    const i = n - 1;
    const cmd = line.match(/node scripts\/tracker\/(cli\.js|post-tests\.js)(.*)$/);
    if (!cmd) return;
    const [, script, rest] = cmd;
    if (script === 'cli.js') {
      const op = (rest.trim().split(/\s+/)[0] || '');
      if (!OPS.has(op)) bad(`${file}:${i + 1}: "cli.js ${op}" is not an operation (${[...OPS].join(', ')})`);
    }
    for (const f of rest.matchAll(/(?:^|\s)(--[a-z-]+)/g)) {
      if (!FLAGS[script].has(f[1])) bad(`${file}:${i + 1}: ${script} has no option ${f[1]}`);
    }
    // 3a. inline --input '{…}'
    const inline = rest.match(/--input '(\{.*\})'/);
    if (inline && /\$[A-Za-z{]|<[^>\n]+>|\{testCasesDir\}/.test(inline[1])) bad(`${file}:${i + 1}: --input '…' holds a $VAR or <placeholder> — untrusted text must never be pasted into a shell string; write the JSON with the Write tool and pass --input-file`);
    if (inline && script === 'cli.js') {
      const op = rest.trim().split(/\s+/)[0];
      try { validateInput(op, JSON.parse(fill(inline[1])), `${file}:${i + 1}`); } catch (e) { bad(`${file}:${i + 1}: example --input is not valid JSON (${e.message})`); }
    }
  });

  // 3b. fenced JSON the prose tells the model to write: validate against the op named just before it
  if (name === 'bug' || name === 'agent') {
    for (const m of md.matchAll(/[ \t]*```json\n([\s\S]*?)\n[ \t]*```/g)) {
      let obj;
      try { obj = JSON.parse(fill(m[1])); } catch (e) { bad(`${file}: a json example does not parse (${e.message})`); continue; }
      if ('title' in obj && 'body' in obj) validateInput('create-bug', obj, `${file} (json example)`);
      if ('evidencePaths' in obj) checkReceipt(obj, md, file);
    }
    // inline `{ "id": …, "body": …, "idempotencyKey": … }` comment inputs
    for (const m of md.matchAll(/`(\{ "id": [^`]*"body": [^`]*\})`|containing `(\{ "id": [^`]*\})`/g)) {
      const text = m[1] || m[2];
      try { validateInput('comment', JSON.parse(fill(text)), `${file} (comment example)`); } catch (e) { bad(`${file}: a comment example does not parse (${e.message}): ${text}`); }
    }
  }

  // 4. no direct API calls left for adapter-backed sources
  const withoutNonAdapterSections = md; // every tracker except Jira has an adapter now: no direct API calls anywhere
  for (const [re, label] of [[/^\s*curl\s/m, 'a curl command'], [/\bgh issue\b/, 'gh issue'], [/api\.clickup\.com/, 'api.clickup.com'], [/dev\.azure\.com/, 'dev.azure.com'], [/_apis\/wit/, 'an Azure REST path'], [/System\.History/, 'System.History']]) {
    if (re.test(withoutNonAdapterSections)) bad(`${file}: still contains ${label} — adapter-backed sources must go through the CLI`);
  }

  // 5. every registered adapter is named in the adapter section
  if (name !== 'agent') {
    const section = md.match(/### [^\n]*tracker adapter CLI[\s\S]*?(?=\n### |\n## |$(?![\s\S]))/i);
    const heading = (md.match(/### ([^\n]*tracker adapter CLI)/i) || [])[1] || '';
    if (!section) bad(`${file}: no "… via the tracker adapter CLI" section`);
    else for (const a of SUPPORTED) if (!new RegExp(a, 'i').test(heading)) bad(`${file}: adapter "${a}" is registered but missing from the section heading "${heading}"`);
  } else {
    const step6 = (md.match(/- \*\*([^*]*)\*\* — through the tracker adapter CLI/) || [])[1] || '';
    if (!step6) bad(`${file}: Step 6 has no "… — through the tracker adapter CLI" bullet`);
    else for (const a of SUPPORTED) if (!new RegExp(a, 'i').test(step6)) bad(`${file}: adapter "${a}" is registered but missing from Step 6 ("${step6.trim()}")`);
  }
}

// ── run-spec-tests.md: the structured-results runner ──────────────────────────────
{
  const file = '.claude/commands/run-spec-tests.md';
  const md = read(file);
  const runFlags = flagsIn(read('scripts/results/run.js'));
  const { SUPPORTED: FRAMEWORKS } = require(path.join(ROOT, 'scripts/results/frameworks.js'));
  logicalLines(md).forEach(({ text: line, n }) => {
    const i = n - 1;
    const cmd = line.match(/node scripts\/results\/run\.js(.*)$/);
    if (!cmd) return;
    for (const f of cmd[1].matchAll(/(?:^|\s)(--[a-z-]+)/g)) if (!runFlags.has(f[1])) bad(`${file}:${i + 1}: run.js has no option ${f[1]}`);
    const fw = cmd[1].match(/--framework\s+(\S+)/);
    if (!fw) bad(`${file}:${i + 1}: run.js example has no --framework`);
    else if (!FRAMEWORKS.includes(fw[1])) bad(`${file}:${i + 1}: "${fw[1]}" is not a framework run.js knows (${FRAMEWORKS.join(', ')})`);
  });
  if (!/node scripts\/results\/run\.js/.test(md)) bad(`${file}: no longer calls scripts/results/run.js`);
  if (/--reporter=list\b(?!,)/.test(md)) bad(`${file}: still tells the model to read a list reporter's console output`);
  // every `totals.x` / `error.x` the prose says to read must exist in the result schema
  const resultSchema = JSON.parse(read('schemas/run-result.schema.json'));
  const testProps = resultSchema.properties.tests.items.properties;
  const fields = { totals: resultSchema.properties.totals.properties, error: testProps.error.properties };
  for (const m of md.matchAll(/`(totals|error)\.([A-Za-z]+)`/g)) {
    if (!(m[2] in fields[m[1]])) bad(`${file}: tells the model to read ${m[1]}.${m[2]}, which schemas/run-result.schema.json does not define`);
  }
  for (const m of md.matchAll(/`(flaky|durationMs|ticket|caseId|status)\b[^`]*`/g)) {
    if (!(m[1] in testProps) && !(m[1] in resultSchema.properties)) bad(`${file}: mentions result field "${m[1]}", which the schema does not define`);
  }
}

// ── $ARGUMENTS on a shell line needs a stated allow-list ────────────────────────────────────
for (const f of fs.readdirSync(path.join(ROOT, '.claude/commands')).filter((x) => x.endsWith('.md'))) {
  const file = '.claude/commands/' + f; const md = read(file);
  const onShell = logicalLines(md).filter(({ text }) => /(^|[\s`(])(node|cp|find|diff|jq|mkdir|ls|rm|git)\s[^\n]*\$ARGUMENTS/.test(text));
  if (onShell.length && !/`\^\[[^`\n]*\$`/.test(md)) bad(`${file}:${onShell[0].n}: puts $ARGUMENTS on a shell line but never states an anchored allow-list for it (a ^[…]…$ pattern in backticks)`);
}

// ── every idempotency key template in the prose must fill in to a value the key rules accept ─────────────────
// (an ISO timestamp holds ":" and an unbounded id can pass 80 characters; the examples above fill "<…>" with a plain "x", so they never noticed)
const { assertKey } = require(path.join(ROOT, 'scripts/tracker/lib/contract.js'));
for (const file of [...Object.values(FILES), ...fs.readdirSync(path.join(ROOT, '.claude/commands')).filter((x) => x.endsWith('.md')).map((f) => '.claude/commands/' + f)]) {
  const text = read(file);
  // the longest slug the prose allows ("at most N characters"); the key rules are then tested with a slug of exactly that length
  const slugMax = (text.match(/where `<slug>` is[^:\n]*?at most (\d+) characters/) || [])[1];
  for (const m of text.matchAll(/"idempotencyKey":\s*"([^"]*)"/g)) {
    const template = m[1];
    if (/<slug>/.test(template) && !slugMax) { bad(`${file}: idempotencyKey "${template}" uses <slug> but the prose never says how long a slug may be ("at most N characters")`); continue; }
    const filled = template.replace(/\$ARGUMENTS/g, 'DEMO-101').replace(/<YYYYMMDDTHHMMSSZ[^>]*>/g, '20260101T000000Z').replace(/<slug>/g, 'a'.repeat(Number(slugMax || 0)));
    if (/[<>$]/.test(filled)) { bad(`${file}: idempotencyKey "${template}" holds a placeholder this check cannot fill in (write a time as <YYYYMMDDTHHMMSSZ…>)`); continue; }
    try { assertKey(filled); } catch { bad(`${file}: idempotencyKey "${template}" fills in to "${filled}", which the key rules reject (1-80 characters of letters, digits, ".", "_" or "-")`); }
  }
}

if (problems.length) { console.log(`${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`); process.exit(1); }
console.log('OK');

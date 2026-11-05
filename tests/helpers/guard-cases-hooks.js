// Runs tests/fixtures/guard-cases.json through the REAL shell hooks (hooks/prod-guard.sh for commands, hooks/env-detector.sh for file
// content), in both guard modes: the same decisions the runtime guards must give, observed from the outside (exit code + output).
// Only URLs the hooks can SEE are used: they pull http(s) URLs out of text, so a case whose URL that extraction would cut short or
// not find (a backtick, `ftp://`, a bare host) is exercised by the library tests instead. Prints "OK" or each mismatch.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..', '..');
const { extractUrls } = require(path.join(root, 'hooks', 'lib', 'url-guard.js'));
const table = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'guard-cases.json'), 'utf8'));

const dirs = {};
const dirFor = (name) => {
  if (dirs[name]) return dirs[name];
  const c = table.configs[name];
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-guard-'));
  const protection = {};
  for (const k of ['prodUrlPatterns', 'allowedUrlPatterns', 'blockOnSuspiciousUrls']) if (c[k] !== undefined) protection[k] = c[k];
  const doc = { productionProtection: protection };
  if (c.testEnvironmentBaseUrl) doc.environments = { testEnvironmentBaseUrl: c.testEnvironmentBaseUrl };
  fs.writeFileSync(path.join(dir, 'qa-config.json'), JSON.stringify(doc));
  return (dirs[name] = dir);
};

const HOOKS = {
  'prod-guard.sh': (url) => ({ tool_input: { command: `curl -s ${url}` } }),
  'env-detector.sh': (url) => ({ tool_name: 'Write', tool_input: { file_path: 'tests/x.spec.ts', content: `const base = "${url}";\n` } }),
};

const env = (mode) => { const e = { ...process.env }; delete e.QA_AUTONOMOUS; delete e.QA_HARNESS_DIR; delete e.CLAUDE_PROJECT_DIR; if (mode === 'enforce') e.QA_AUTONOMOUS = '1'; return e; };

let bad = 0; let ran = 0; let skipped = 0;
for (const c of table.cases) {
  const seen = extractUrls(`curl -s ${c.url}`);
  const seenInContent = extractUrls(`const base = "${c.url}";`);
  if (seen.length !== 1 || seen[0] !== c.url || seenInContent.length !== 1 || seenInContent[0] !== c.url) { skipped += 1; continue; }
  for (const [hook, input] of Object.entries(HOOKS)) {
    for (const mode of ['enforce', 'warn']) {
      const r = spawnSync('bash', [path.join(root, 'hooks', hook)], { cwd: dirFor(c.config), input: JSON.stringify(input(c.url)), env: env(mode), encoding: 'utf8' });
      const out = `${r.stdout}${r.stderr}`;
      const got = r.status === 2 ? 'block' : /WARNING/.test(out) ? 'warn' : 'allow';
      const why = (/Why: ([A-Z_]+)/.exec(out) || [])[1];
      ran += 1;
      const reasonWrong = why && c.reason !== 'PROD_PATTERN' && why !== c.reason;
      if (got !== c.expect[mode] || reasonWrong) { bad += 1; console.log(`MISMATCH ${hook} ${mode} ${JSON.stringify(c.url)} -> ${got}${why ? ` (${why})` : ''} | expected ${c.expect[mode]} ${c.reason}`); }
    }
  }
}
for (const d of Object.values(dirs)) fs.rmSync(d, { recursive: true, force: true });
if (ran < 300) { console.log(`only ${ran} hook runs happened (skipped ${skipped} cases the hooks cannot see): the table or the extraction changed`); process.exit(1); }
console.log(bad ? `${bad} mismatches (of ${ran} hook runs)` : 'OK');
process.exit(bad ? 1 : 0);

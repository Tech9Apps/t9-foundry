'use strict';

// Self-heal against REAL git repositories and the REAL node runner: a throwaway project with a stale selector, a bare repo
// standing in for "origin" (to prove nothing is ever published), and a hook-able .git directory. Each refusal and revert path
// must leave the repository exactly as it was found.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { main: orchestrate } = require('../../scripts/triage/orchestrate');
const { main: healCli, heal, planHeal, eligible } = require('../../scripts/triage/heal');
const { classify } = require('../../scripts/triage/classify');

const IDENT = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test' };
const baseEnv = () => { const e = { ...process.env, ...IDENT }; delete e.NODE_TEST_CONTEXT; return e; };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: baseEnv() }).trim();

const INDEX = '<main><button data-testid="coupon-apply">Apply</button><input data-testid="coupon-input"></main>\n';
const PAGE_JS = `'use strict';
const fs = require('fs'); const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
exports.openPage = () => ({ getByTestId(id) { if (!html.includes('data-testid="' + id + '"')) throw new Error("locator not found: getByTestId('" + id + "')"); } });
`;
const UI_TEST = `const test = require('node:test');
const { openPage } = require('./page');

test('DEMO-101/TC-901: the Apply button is on the cart panel', () => {
  openPage().getByTestId('coupon-apply-btn');
});

test('DEMO-101/TC-902: the coupon box is on the cart panel', () => {
  openPage().getByTestId('coupon-input');
});
`;

// A project with a stale selector, committed on main, with a bare repo as origin.
function makeProject({ files = {}, hook } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-heal-'));
  const proj = path.join(root, 'proj'); const remote = path.join(root, 'remote.git');
  const w = (rel, content) => { const f = path.join(proj, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };
  w('app/index.html', INDEX); w('tests/page.js', PAGE_JS); w('tests/ui.test.js', UI_TEST);
  for (const [rel, content] of Object.entries(files)) w(rel, content);
  fs.mkdirSync(remote); git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(proj, 'init', '-q', '-b', 'main'); git(proj, 'add', '-A'); git(proj, 'commit', '-q', '-m', 'initial');
  git(proj, 'remote', 'add', 'origin', remote); git(proj, 'push', '-q', 'origin', 'main');
  if (hook) { fs.writeFileSync(path.join(proj, '.git', 'hooks', 'pre-commit'), hook, { mode: 0o755 }); }
  const cfg = (triage) => { const f = path.join(root, `cfg-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify({ triage })); return f; };
  return { root, proj, remote, cfg, read: (rel) => fs.readFileSync(path.join(proj, rel), 'utf8'), state: () => ({ head: git(proj, 'rev-parse', 'HEAD'), branch: git(proj, 'rev-parse', '--abbrev-ref', 'HEAD'), branches: git(proj, 'branch', '--format=%(refname:short)'), status: git(proj, 'status', '--porcelain', '--untracked-files=no'), remoteRefs: git(proj, 'ls-remote', 'origin') }) };
}

async function triage(p, { extra = [], triageCfg = { selfHeal: { enabled: true, paths: ['tests'] } } } = {}) {
  let out = '';
  const argv = ['--framework', 'node', '--cwd', p.proj, '--spec', 'tests/ui.test.js', '--out', path.join(p.proj, 'qa-results'), '--preflight', 'ok', '--run-id', 'r1', '--no-plan',
    '--config', p.cfg(triageCfg), '--snapshot', path.join(p.proj, 'app', 'index.html'), ...extra];
  const code = await orchestrate({ argv, env: baseEnv(), stdout: { write: (x) => { out += x; } }, stderr: { write: () => {} } });
  return { code, json: JSON.parse(out) };
}
const stale = '[\'coupon-apply-btn\']';

describe('self-heal, end to end (real git, real runner)', () => {
  test('heals a stale selector: a local branch with ONE commit, validated, main untouched, nothing published', async () => {
    const p = makeProject();
    const before = p.state();
    const r = await triage(p);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    const h = r.json.data.heal;
    assert.equal(h.status, 'healed');
    assert.deepEqual([h.base, h.branch], ['main', 'qa/heal-r1']);
    assert.deepEqual(h.renames, [{ from: 'coupon-apply-btn', to: 'coupon-apply', tests: ['DEMO-101/TC-901'] }]);
    assert.deepEqual(h.validated, { specs: ['tests/ui.test.js'], passed: 2, failed: 0 });
    assert.deepEqual(h.changes, [{ file: 'tests/ui.test.js', lines: [{ line: 5, rename: 'coupon-apply-btn → coupon-apply', before: "openPage().getByTestId('coupon-apply-btn');", after: "openPage().getByTestId('coupon-apply');" }] }]);

    const after = p.state();
    assert.equal(after.head, before.head, 'main is exactly where it was');
    assert.equal(after.branch, 'main', 'the working tree is back on the original branch');
    assert.equal(after.status, '', 'and clean');
    assert.equal(after.remoteRefs, before.remoteRefs, 'NOTHING was published: the remote is unchanged');
    assert.equal(after.branches.split('\n').sort().join(), 'main,qa/heal-r1');
    assert.match(p.read('tests/ui.test.js'), /coupon-apply-btn/, 'main still has the stale selector: the heal only exists on its branch');

    assert.equal(git(p.proj, 'rev-list', '--count', 'main..qa/heal-r1'), '1', 'exactly one commit');
    assert.equal(git(p.proj, 'diff', '--name-only', 'main..qa/heal-r1'), 'tests/ui.test.js');
    const patch = git(p.proj, 'diff', '-U0', 'main..qa/heal-r1').split('\n').filter((l) => /^[+-][^+-]/.test(l));
    assert.deepEqual(patch, ["-  openPage().getByTestId('coupon-apply-btn');", "+  openPage().getByTestId('coupon-apply');"], 'the whole diff is the one id');
    const msg = git(p.proj, 'log', '-1', '--format=%B', 'qa/heal-r1');
    assert.match(msg, /^qa-heal: rename test-id "coupon-apply-btn" -> "coupon-apply" \(run r1\)/);
    assert.match(msg, /A human must review this before it is merged/);
    assert.match(msg, /Validated by re-running tests\/ui\.test\.js: 2 passed, 0 failed/);

    // and the healed branch really passes
    git(p.proj, 'switch', '-q', 'qa/heal-r1');
    assert.doesNotThrow(() => execFileSync('node', ['--test', 'tests/ui.test.js'], { cwd: p.proj, env: baseEnv(), stdio: 'ignore' }));
    git(p.proj, 'switch', '-q', 'main');

    const v = r.json.data.verdicts.find((x) => x.key === 'DEMO-101/TC-901');
    assert.equal(v.healed, true);
    assert.ok(fs.existsSync(path.join(p.proj, 'qa-results', 'heal.json')));
  });

  test('it is OFF by default: the verdict carries the exact proposal, and nothing is edited', async () => {
    const p = makeProject();
    const before = p.state();
    const r = await triage(p, { triageCfg: {} });
    assert.equal(r.json.data.heal, undefined);
    assert.deepEqual(r.json.data.verdicts[0].proposal, { kind: 'rename-testid', from: 'coupon-apply-btn', to: 'coupon-apply', similarity: 0.8 });
    assert.match(r.json.data.rerunNotes.join(' '), /self-heal is off/);
    assert.deepEqual(r.json.data.settings.selfHeal, { value: false, from: 'default' });
    assert.deepEqual(p.state(), before);
    assert.match(p.read('tests/ui.test.js'), /coupon-apply-btn/);
  });

  test('--heal turns it on without a config; --no-heal beats a config that turned it on', async () => {
    const on = makeProject();
    const a = await triage(on, { triageCfg: { selfHeal: { paths: ['tests'] } }, extra: ['--heal'] });
    assert.equal(a.json.data.heal.status, 'healed');
    assert.deepEqual(a.json.data.settings.selfHeal, { value: true, from: 'flag' });
    const off = makeProject();
    const b = await triage(off, { extra: ['--no-heal'] });
    assert.equal(b.json.data.heal, undefined);
    assert.equal(off.state().branches, 'main');
  });

  test('a stale reference in a file with NOTHING to edit is still reported (a heal that looks complete must be)', async () => {
    const p = makeProject({ files: { 'tests/helpers/ids.js': "exports.APPLY = 'coupon-apply-btn';\n" } });
    const r = await triage(p);
    assert.equal(r.json.data.heal.status, 'healed');
    assert.deepEqual(r.json.data.heal.leftovers, [{ file: 'tests/helpers/ids.js', line: 1, text: "exports.APPLY = 'coupon-apply-btn';" }]);
    assert.equal(git(p.proj, 'diff', '--name-only', 'main..qa/heal-r1'), 'tests/ui.test.js', 'and that file was not edited');
  });

  test('a constant or comment that still mentions the old id is NOT edited, and the heal says it may be partial', async () => {
    const p = makeProject({ files: { 'tests/page.js': `${PAGE_JS}// the Apply button used to be coupon-apply-btn\n` } });
    const r = await triage(p);
    const h = r.json.data.heal;
    assert.equal(h.status, 'healed');
    assert.deepEqual(h.leftovers.map((l) => l.file), ['tests/page.js']);
    assert.match(h.note, /NOT edited/);
    assert.match(git(p.proj, 'show', 'qa/heal-r1:tests/page.js'), /used to be coupon-apply-btn/);
  });
});

describe('self-heal refuses, and the repository is left exactly as found', () => {
  const refused = async (p, expectReason, opts) => {
    const before = p.state();
    const files = fs.readFileSync(path.join(p.proj, 'tests', 'ui.test.js'), 'utf8');
    const r = await triage(p, opts);
    assert.equal(r.json.data.heal.status, 'refused', JSON.stringify(r.json.data.heal));
    assert.match(r.json.data.heal.reason, expectReason);
    assert.match(r.json.data.warnings.join(' '), /self-heal refused/);
    assert.deepEqual(p.state(), { ...before, status: before.status });
    assert.equal(fs.readFileSync(path.join(p.proj, 'tests', 'ui.test.js'), 'utf8'), files, 'no file was written');
    return r;
  };

  test('uncommitted changes to tracked files: a heal never mixes its edits with yours', async () => {
    const p = makeProject();
    fs.appendFileSync(path.join(p.proj, 'app', 'index.html'), '<!-- wip -->\n');
    await refused(p, /uncommitted changes to tracked files/);
  });
  test('a detached HEAD', async () => {
    const p = makeProject();
    git(p.proj, 'checkout', '-q', '--detach');
    await refused(p, /HEAD is detached/);
  });
  test('a branch of that name already exists', async () => {
    const p = makeProject();
    git(p.proj, 'branch', 'qa/heal-r1');
    await refused(p, /branch qa\/heal-r1 already exists/);
  });
  test('the run directory is not a git repository', async () => {
    const p = makeProject();
    fs.rmSync(path.join(p.proj, '.git'), { recursive: true, force: true });
    const r = await triage(p);
    assert.equal(r.json.data.heal.status, 'refused');
    assert.match(r.json.data.heal.reason, /not inside a git repository/);
    assert.match(p.read('tests/ui.test.js'), /coupon-apply-btn/);
  });
  test('no test directories configured, or one that does not exist or leaves the repository', async () => {
    const p = makeProject();
    await refused(p, /no test directories are configured/, { triageCfg: { selfHeal: { enabled: true } } });
    await refused(makeProject(), /no such directory/, { triageCfg: { selfHeal: { enabled: true, paths: ['nope'] } } });
    await refused(makeProject(), /resolves outside the repository/, { triageCfg: { selfHeal: { enabled: true, paths: ['..'] } } });
  });
  test('the old id found in test code only outside the allowed directories: nothing to heal, not a refusal', async () => {
    const p = makeProject({ files: { 'e2e/other.js': 'x' } });
    const r = await triage(p, { triageCfg: { selfHeal: { enabled: true, paths: ['e2e'] } } });
    assert.equal(r.json.data.heal.status, 'nothing-to-heal');
    assert.match(r.json.data.heal.reason, /no locator for "coupon-apply-btn" was found in e2e/);
    assert.equal(p.state().branches, 'main');
  });
  test('the substitution guard stops a heal it cannot PROVE touches only the id (a line that already contains the new id)', async () => {
    const p = makeProject({ files: { 'tests/po.js': "check('coupon-apply'); page.getByTestId('coupon-apply-btn');\n" } });
    const r = await refused(p, /the edit would change more than the test-id \(line 1 differs by more than the id\); nothing was written/);
    assert.equal(r.json.data.heal.reason.includes('tests/po.js'), true, 'and it says which file');
  });

  test('over the file cap, or the line cap: refused, not applied', async () => {
    const many = {};
    for (let i = 1; i <= 3; i += 1) many[`tests/po${i}.js`] = `exports.a = () => page.getByTestId('coupon-apply-btn');\n`;
    await refused(makeProject({ files: many }), /touch 4 files, more than the limit of 2 \(triage\.selfHeal\.maxFiles\)/, { triageCfg: { selfHeal: { enabled: true, paths: ['tests'], maxFiles: 2 } } });
    const lines = { 'tests/po.js': Array.from({ length: 5 }, () => `x(page.getByTestId('coupon-apply-btn'));`).join('\n') };
    await refused(makeProject({ files: lines }), /change 6 lines, more than the limit of 3 \(triage\.selfHeal\.maxLines\)/, { triageCfg: { selfHeal: { enabled: true, paths: ['tests'], maxLines: 3 } } });
  });
});

describe('self-heal reverts everything when validation fails', () => {
  test('the healed test still fails (a second stale selector): the branch is deleted and the files restored', async () => {
    const two = UI_TEST.replace("openPage().getByTestId('coupon-apply-btn');", "openPage().getByTestId('coupon-apply-btn');\n  openPage().getByTestId('also-missing');");
    const p = makeProject({ files: { 'tests/ui.test.js': two } });
    const before = p.state();
    const r = await triage(p);
    const h = r.json.data.heal;
    assert.equal(h.status, 'reverted');
    assert.match(h.reason, /still does not pass/);
    assert.equal(h.restored, true);
    assert.deepEqual(p.state(), before, 'HEAD, branch, branch list, status and remote are all as they were');
    assert.equal(p.read('tests/ui.test.js'), two);
    assert.match(r.json.data.warnings.join(' '), /self-heal reverted.*repository was restored/);
  });

  test('a pre-commit hook that rejects the commit is respected, and the heal is reverted', async () => {
    const p = makeProject({ hook: '#!/bin/sh\necho "rejected by hook" >&2\nexit 1\n' });
    const before = p.state();
    const r = await triage(p);
    assert.equal(r.json.data.heal.status, 'reverted');
    assert.match(r.json.data.heal.reason, /git commit failed/);
    assert.deepEqual(p.state(), before);
    assert.match(p.read('tests/ui.test.js'), /coupon-apply-btn/);
  });
});

// ── heal() directly: crafted situations the real runner cannot easily produce ─────────────────────
describe('heal(): crafted verdicts and validation results', () => {
  const verdict = (extra = {}) => ({ key: 'DEMO-101/TC-901', test: { name: 'DEMO-101/TC-901: x', ticket: 'DEMO-101', caseId: 'TC-901', file: 'tests/ui.test.js' }, class: 'test-bug', rule: 'TST-1', confidence: 0.85, action: 'act', evidence: ['e'], attempts: [], fingerprint: 'a'.repeat(12), token: `qafp${'a'.repeat(12)}`, signature: 's', proposal: { kind: 'rename-testid', from: 'coupon-apply-btn', to: 'coupon-apply', similarity: 0.8 }, ...extra });
  const rep = (...v) => ({ verdicts: v });
  const ok = (extra = {}) => ({ totals: { total: 2, passed: 2, failed: 0, skipped: 0 }, tests: [{ name: 'DEMO-101/TC-901: x', ticket: 'DEMO-101', caseId: 'TC-901', file: 'tests/ui.test.js', status: 'passed' }, { name: 'DEMO-101/TC-902: y', ticket: 'DEMO-101', caseId: 'TC-902', file: 'tests/ui.test.js', status: 'passed' }], ...extra });
  const run = (p, report, validate, opts = {}) => heal({ report, cwd: p.proj, runId: 'r1', paths: ['tests'], validate, mainRun: { tests: [{ name: 'DEMO-101/TC-902: y', ticket: 'DEMO-101', caseId: 'TC-902', file: 'tests/ui.test.js', status: 'passed' }] }, ...opts });

  test('a test that passed before but fails after the rename is a regression: reverted', async () => {
    const p = makeProject(); const before = p.state();
    const broke = ok(); broke.tests[1].status = 'failed';
    const r = await run(p, rep(verdict()), async () => broke);
    assert.equal(r.status, 'reverted');
    assert.match(r.reason, /broke DEMO-101\/TC-902, which passed before/);
    assert.deepEqual(p.state(), before);
  });

  test('a validation run that produces nothing is a failure, not a pass', async () => {
    const p = makeProject(); const before = p.state();
    for (const result of [null, {}, { tests: 'x' }]) {
      const r = await run(p, rep(verdict()), async () => result);
      assert.equal(r.status, 'reverted', JSON.stringify(result));
      assert.match(r.reason, /no usable result/);
    }
    assert.deepEqual(p.state(), before);
  });

  test('a validator that throws reverts too', async () => {
    const p = makeProject(); const before = p.state();
    const r = await run(p, rep(verdict()), async () => { throw new Error('runner exploded'); });
    assert.deepEqual([r.status, r.reason], ['reverted', 'runner exploded']);
    assert.deepEqual(p.state(), before);
  });

  test('a healed test that is missing from the validation result does not count as passing', async () => {
    const p = makeProject();
    const gone = ok(); gone.tests.shift();
    assert.equal((await run(p, rep(verdict()), async () => gone)).status, 'reverted');
  });

  test('an unsafe new id (it comes from untrusted page HTML) is refused before anything is written', async () => {
    const p = makeProject(); const before = p.state();
    for (const to of ["x');process.exit(1);//", 'a b', 'x"]', '$(touch pwned)']) {
      const r = await run(p, rep(verdict({ proposal: { kind: 'rename-testid', from: 'coupon-apply-btn', to } })), async () => ok());
      assert.equal(r.status, 'refused', to);
      assert.match(r.reason, /could break out of a string or selector/);
    }
    assert.deepEqual(p.state(), before);
    assert.ok(!fs.existsSync(path.join(p.proj, 'pwned')));
  });

  test('one id renamed to two different ids is ambiguous and refused', async () => {
    const p = makeProject();
    const r = await run(p, rep(verdict(), verdict({ key: 'DEMO-101/TC-903', proposal: { kind: 'rename-testid', from: 'coupon-apply-btn', to: 'other' } })), async () => ok());
    assert.equal(r.status, 'refused');
    assert.match(r.reason, /two different ids/);
  });

  test('two tests that need the same rename share one commit and both are listed', async () => {
    const p = makeProject();
    const both = ok(); both.tests.push({ name: 'DEMO-101/TC-903: z', ticket: 'DEMO-101', caseId: 'TC-903', file: 'tests/ui.test.js', status: 'passed' });
    const r = await run(p, rep(verdict(), verdict({ key: 'DEMO-101/TC-903', test: { name: 'DEMO-101/TC-903: z', ticket: 'DEMO-101', caseId: 'TC-903', file: 'tests/ui.test.js' } })), async () => both);
    assert.equal(r.status, 'healed');
    assert.deepEqual(r.renames[0].tests, ['DEMO-101/TC-901', 'DEMO-101/TC-903']);
    assert.equal(git(p.proj, 'rev-list', '--count', 'main..qa/heal-r1'), '1');
  });

  test('only a TST-1 verdict at act confidence with an exact proposal is ever eligible', () => {
    const cases = [verdict({ rule: 'TST-2' }), verdict({ rule: 'TST-3' }), verdict({ action: 'propose' }), verdict({ proposal: undefined }), verdict({ class: 'product-bug', rule: 'PRD-1' }), verdict({ proposal: { kind: 'something-else', from: 'a', to: 'b' } })];
    for (const v of cases) assert.deepEqual(eligible(rep(v)), [], JSON.stringify([v.rule, v.action]));
    assert.equal(eligible(rep(verdict())).length, 1);
  });

  test('nothing eligible is "nothing to heal", never an error, and touches nothing', async () => {
    const p = makeProject(); const before = p.state();
    const r = await run(p, rep(verdict({ rule: 'TST-3' })), async () => ok());
    assert.equal(r.status, 'nothing-to-heal');
    assert.deepEqual(p.state(), before);
  });

  test('the heal branch prefix must be under qa/ even when called programmatically', async () => {
    const p = makeProject(); const before = p.state();
    for (const branchPrefix of ['main', 'release/', '', 'qa/../main']) {
      const r = await run(p, rep(verdict()), async () => ok(), { branchPrefix });
      assert.equal(r.status, 'refused', branchPrefix);
      assert.match(r.reason, /must start with "qa\/"/);
    }
    assert.deepEqual(p.state(), before);
  });

  test('preview (apply: false) shows the exact change and writes nothing, touches no git state', async () => {
    const p = makeProject(); const before = p.state();
    const r = await run(p, rep(verdict()), async () => { throw new Error('must not validate a preview'); }, { apply: false });
    assert.equal(r.status, 'preview');
    assert.equal(r.changedLines, 1);
    assert.equal(r.changes[0].lines[0].after, "openPage().getByTestId('coupon-apply');");
    assert.deepEqual(p.state(), before);
    assert.match(p.read('tests/ui.test.js'), /coupon-apply-btn/);
  });

  test('planHeal reports files and lines without needing git state to be clean', () => {
    const p = makeProject();
    fs.appendFileSync(path.join(p.proj, 'app', 'index.html'), 'dirty\n');
    const plan = planHeal({ report: rep(verdict()), cwd: p.proj, paths: ['tests'], maxFiles: 5, maxLines: 20 });
    assert.equal(plan.files.length, 1);
    assert.equal(plan.lines, 1);
  });
});

describe('heal.js never publishes', () => {
  test('there is no code path that runs git push (or any remote operation), in heal.js or its helpers', () => {
    for (const f of ['heal.js', 'lib/heal-core.js', 'lib/run-results.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'triage', f), 'utf8');
      assert.doesNotMatch(src, /['"`]push['"`]|git push|['"`](?:remote|fetch|pull|clone)['"`]|gh pr|gh api|curl/, f);
    }
    const heal = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'triage', 'heal.js'), 'utf8');
    const gitCalls = [...heal.matchAll(/git\(\s*\w+,\s*\[\s*'([a-z-]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(gitCalls)].sort(), ['add', 'branch', 'checkout', 'commit', 'rev-parse', 'status', 'switch'], 'the complete list of git subcommands it can run, all local');
  });
});

// ── the CLI ──────────────────────────────────────────────────────────────────────────────────────
describe('heal CLI', () => {
  const cli = async (argv, runResults) => { let out = ''; let err = ''; const code = await healCli({ argv, env: baseEnv(), stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, ...(runResults ? { runResults } : {}) }); return { code, err, json: out ? JSON.parse(out) : null }; };
  const reportFor = (p) => {
    const t = (status, extra = {}) => ({ name: 'DEMO-101/TC-901: the Apply button is on the cart panel', ticket: 'DEMO-101', caseId: 'TC-901', file: path.join(p.proj, 'tests', 'ui.test.js'), status, ...extra });
    const stale = { kind: 'failure', message: "locator not found: getByTestId('coupon-apply-btn')" };
    // 'tap' is trusted by default; a result with no format, or an unverified one, is held at propose and never healed
    const rep = classify({ runs: [1, 2, 3].map(() => ({ format: 'tap', tests: [t('failed', { error: stale })] })), evidence: { 'DEMO-101/TC-901': { locator: { target: 'coupon-apply-btn', present: false, candidates: [{ testid: 'coupon-apply', similarity: 0.8, tag: 'button', text: 'Apply' }] } } } });
    const f = path.join(p.root, 'triage.json'); fs.writeFileSync(f, JSON.stringify({ ok: true, data: rep }));
    return f;
  };

  test('without --apply it only previews: the lines that would change, and nothing written', async () => {
    const p = makeProject(); const before = p.state();
    const r = await cli(['--report', reportFor(p), '--cwd', p.proj, '--paths', 'tests']);
    assert.equal(r.code, 0);
    assert.equal(r.json.data.status, 'preview');
    assert.deepEqual(p.state(), before);
    assert.match(p.read('tests/ui.test.js'), /coupon-apply-btn/);
  });

  test('--apply needs the main run and the framework (it validates by re-running)', async () => {
    const p = makeProject();
    assert.equal((await cli(['--report', reportFor(p), '--apply'])).code, 2);
    assert.match((await cli(['--report', reportFor(p), '--apply'])).err, /--apply needs --main/);
  });

  test('--apply heals with the validation injected, and --out records the result', async () => {
    const p = makeProject();
    const mainRun = path.join(p.root, 'main.json'); fs.writeFileSync(mainRun, JSON.stringify({ ok: false, data: { tests: [] } }));
    const out = path.join(p.root, 'out', 'heal.json');
    const pass = { totals: { passed: 1, failed: 0 }, tests: [{ name: 'DEMO-101/TC-901: the Apply button is on the cart panel', ticket: 'DEMO-101', caseId: 'TC-901', file: path.join(p.proj, 'tests', 'ui.test.js'), status: 'passed' }] };
    const r = await cli(['--report', reportFor(p), '--main', mainRun, '--framework', 'node', '--cwd', p.proj, '--paths', 'tests', '--apply', '--run-id', 'cli1', '--out', out], async () => ({ code: 0, doc: { ok: true, data: pass } }));
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.equal(r.json.data.branch, 'qa/heal-cli1');
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), r.json);
  });

  test('a refusal exits 1 with the reason; bad input exits 2 or 1 naming the file', async () => {
    const p = makeProject();
    fs.appendFileSync(path.join(p.proj, 'app', 'index.html'), 'dirty\n');
    const mainRun = path.join(p.root, 'main.json'); fs.writeFileSync(mainRun, JSON.stringify({ tests: [] }));
    const r = await cli(['--report', reportFor(p), '--main', mainRun, '--framework', 'node', '--cwd', p.proj, '--paths', 'tests', '--apply'], async () => ({ code: 0, doc: { ok: true, data: { tests: [] } } }));
    assert.equal(r.code, 1);
    assert.equal(r.json.data.status, 'refused');
    assert.equal((await cli(['--report', path.join(p.root, 'nope.json')])).json.error.code, 'UNREADABLE');
    const bad = path.join(p.root, 'bad.json'); fs.writeFileSync(bad, '{"x":1}');
    assert.match((await cli(['--report', bad])).json.error.message, /no "verdicts" array/);
    for (const argv of [[], ['--bogus'], ['--report'], ['--report', 'x', '--max-files', '0'], ['--report', 'x', '--max-lines', 'abc']]) assert.equal((await cli(argv)).code, 2, argv.join(' '));
  });
});

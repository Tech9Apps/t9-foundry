'use strict';

// Self-heal against REAL git repositories and the REAL node runner: a throwaway project with a stale selector, a bare repo
// standing in for "origin" (to prove nothing is ever published), and a hook-able .git directory. Each refusal and revert path
// must leave the repository exactly as it was found.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { main: orchestrate } = require('../../scripts/triage/orchestrate');
const { main: healCli, heal, planHeal, eligible, provenanceProblems } = require('../../scripts/triage/heal');
const { classify } = require('../../scripts/triage/classify');

const { baseEnv, git, PAGE_JS, UI_TEST, makeProject: makeHealProject } = require('../helpers/heal-project');

// Every project in this file has a bare repository as its origin: the tests check that a heal never touches it.
const makeProject = (opts) => makeHealProject({ remote: true, ...opts });

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
    assert.deepEqual(h.validated, { scope: 'specs', specs: ['tests/ui.test.js'], passed: 2, failed: 0 });
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

  test('--heal together with --no-heal is a usage error, whichever comes first', async () => {
    const p = makeProject();
    for (const flags of [['--heal', '--no-heal'], ['--no-heal', '--heal']]) {
      let err = '';
      const code = await orchestrate({ argv: ['--framework', 'node', '--cwd', p.proj, '--out', path.join(p.proj, 'qa-results'), ...flags], env: baseEnv(), stdout: { write: () => {} }, stderr: { write: (x) => { err += x; } } });
      assert.equal(code, 2, flags.join(' '));
      assert.match(err, /--heal and --no-heal contradict each other/);
    }
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

  // ── review findings, with the REAL runner ──
  const LEGACY_PAGE = PAGE_JS.replace("'index.html'", "'legacy.html'");
  const OTHER_SPEC = `const test = require('node:test');
const { openPage } = require('./legacy-page');

test('DEMO-777/TC-001: the legacy page still has its Apply button', () => {
  openPage().getByTestId('coupon-apply-btn');
});
`;

  test('a SECOND spec that still uses the old id (on a page where it is valid) is broken by the rename: the heal is reverted, not committed as "validated"', async () => {
    const p = makeProject({ files: { 'app/legacy.html': '<button data-testid="coupon-apply-btn">Apply</button>\n', 'tests/legacy-page.js': LEGACY_PAGE, 'tests/other.test.js': OTHER_SPEC } });
    const before = p.state();
    const r = await triage(p); // the main run covers tests/ui.test.js only: other.test.js passes on its own page and was never part of it
    const h = r.json.data.heal;
    assert.equal(h.status, 'reverted', JSON.stringify(h));
    assert.match(h.reason, /the rename broke DEMO-777\/TC-001, which had not failed before/);
    assert.equal(h.restored, true);
    assert.deepEqual(p.state(), before);
    assert.match(p.read('tests/ui.test.js'), /coupon-apply-btn/);
    assert.match(p.read('tests/other.test.js'), /coupon-apply-btn/, 'the second spec was put back too');
  });

  test('when the locator lives in a SHARED HELPER, the whole selection is re-run (and the heal goes through when nothing breaks)', async () => {
    const helper = "const { openPage } = require('../page');\nexports.applyButton = () => openPage().getByTestId('coupon-apply-btn');\nexports.couponInput = () => openPage().getByTestId('coupon-input');\n";
    const spec = "const test = require('node:test');\nconst cart = require('./pages/cart.page');\n\ntest('DEMO-101/TC-901: the Apply button is on the cart panel', () => { cart.applyButton(); });\n\ntest('DEMO-101/TC-902: the coupon box is on the cart panel', () => { cart.couponInput(); });\n";
    const p = makeProject({ files: { 'tests/pages/cart.page.js': helper, 'tests/ui.test.js': spec } });
    const r = await triage(p);
    const h = r.json.data.heal;
    assert.equal(h.status, 'healed', JSON.stringify(h));
    assert.deepEqual(h.changes.map((c) => c.file), ['tests/pages/cart.page.js'], 'the helper was edited, not the spec');
    assert.deepEqual([h.validated.scope, h.validated.specs, h.validated.passed, h.validated.failed], ['selection', [], 2, 0]);
  });
});

// ── heal() directly: crafted situations the real runner cannot easily produce ─────────────────────
describe('heal(): crafted verdicts and validation results', () => {
  // internally consistent, as a verdict from classify.js is: the error is about the id being renamed, and the evidence names both ids
  const verdict = (extra = {}) => {
    const proposal = extra.proposal || { kind: 'rename-testid', from: 'coupon-apply-btn', to: 'coupon-apply', similarity: 0.8 };
    return { key: 'DEMO-101/TC-901', test: { name: 'DEMO-101/TC-901: x', ticket: 'DEMO-101', caseId: 'TC-901', file: 'tests/ui.test.js' }, class: 'test-bug', rule: 'TST-1', confidence: 0.85, action: 'act',
      evidence: [`the test looks for "${proposal.from}", which is not on the page, but "${proposal.to}" is (similarity 0.8)`], error: { kind: 'failure', message: `locator not found: getByTestId('${proposal.from}')` },
      attempts: [], fingerprint: 'a'.repeat(12), token: `qafp${'a'.repeat(12)}`, signature: 's', proposal, ...extra };
  };
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

  // ── review findings: each one is reproduced against a REAL repository ────────────────────────────

  describe('only files git tracks are edited (an untracked or ignored file cannot be restored)', () => {
    const wip = (id = 'coupon-apply-btn') => `const test = require('node:test');\nconst { openPage } = require('./page');\ntest('wip', () => { openPage().getByTestId('${id}'); });\n`;

    test('an UNTRACKED file that also holds the old id: refused before anything is written, and both files are left exactly as they were', async () => {
      const p = makeProject(); fs.writeFileSync(path.join(p.proj, 'tests', 'wip.test.js'), wip()); const before = p.state();
      const r = await run(p, rep(verdict()), async () => ok());
      assert.equal(r.status, 'refused');
      assert.match(r.reason, /tests\/wip\.test\.js is not tracked by git \(new or ignored\) but would need the same rename/);
      assert.deepEqual(p.state(), before);
      assert.match(p.read('tests/wip.test.js'), /coupon-apply-btn/, 'the untracked file was not touched');
      assert.match(p.read('tests/ui.test.js'), /coupon-apply-btn/, 'and neither was the tracked one: the heal is not half-done');
      assert.equal(git(p.proj, 'status', '--porcelain', '--untracked-files=all'), '?? tests/wip.test.js');
    });

    test('an IGNORED file that also holds the old id is refused the same way', async () => {
      const p = makeProject({ files: { '.gitignore': 'tests/scratch.test.js\n' } });
      fs.writeFileSync(path.join(p.proj, 'tests', 'scratch.test.js'), wip()); const before = p.state();
      const r = await run(p, rep(verdict()), async () => ok());
      assert.equal(r.status, 'refused');
      assert.match(r.reason, /tests\/scratch\.test\.js is not tracked by git/);
      assert.deepEqual(p.state(), before);
      assert.match(p.read('tests/ui.test.js'), /coupon-apply-btn/);
    });

    test('an untracked file WITHOUT the old id is none of the heal\'s business: it heals, and the file is still there afterwards, untouched', async () => {
      const p = makeProject(); const other = path.join(p.proj, 'tests', 'notes.test.js'); fs.writeFileSync(other, wip('some-other-id'));
      const r = await run(p, rep(verdict()), async () => ok());
      assert.equal(r.status, 'healed', JSON.stringify(r));
      assert.equal(fs.readFileSync(other, 'utf8'), wip('some-other-id'));
      assert.equal(git(p.proj, 'status', '--porcelain', '--untracked-files=all'), '?? tests/notes.test.js');
      assert.equal(git(p.proj, 'show', '--stat', '--format=', 'qa/heal-r1').split('\n').filter((l) => /\|/.test(l)).length, 1, 'the commit holds exactly one file');
    });

    test('the heal commit never contains an untracked file (it used to `git add` whatever it had edited, tracked or not)', async () => {
      const p = makeProject(); fs.writeFileSync(path.join(p.proj, 'tests', 'later.test.js'), wip('unrelated'));
      const r = await run(p, rep(verdict()), async () => ok());
      assert.equal(r.status, 'healed');
      assert.deepEqual(git(p.proj, 'show', '--name-only', '--format=', 'qa/heal-r1').split('\n'), ['tests/ui.test.js']);
    });
  });

  describe('the restore does not depend on git being in a good state, and is checked', () => {
    test('a validator that DELETES an edited file mid-heal: the file is back, byte for byte, and the branch is gone', async () => {
      const p = makeProject(); const before = p.state(); const original = fs.readFileSync(path.join(p.proj, 'tests', 'ui.test.js'));
      const r = await run(p, rep(verdict()), async () => { fs.rmSync(path.join(p.proj, 'tests', 'ui.test.js')); throw new Error('the harness crashed'); });
      assert.equal(r.status, 'reverted');
      assert.equal(r.restored, true, JSON.stringify(r));
      assert.ok(fs.readFileSync(path.join(p.proj, 'tests', 'ui.test.js')).equals(original));
      assert.deepEqual(p.state(), before);
    });

    test('when git itself is wedged during the restore (a stale index.lock), the files STILL get their original bytes back, and the result says restored: false and why', async () => {
      const p = makeProject(); const ui = path.join(p.proj, 'tests', 'ui.test.js'); const original = fs.readFileSync(ui); const lock = path.join(p.proj, '.git', 'index.lock');
      const r = await run(p, rep(verdict()), async () => { fs.writeFileSync(lock, ''); throw new Error('the harness crashed'); });
      try {
        assert.equal(r.status, 'reverted');
        assert.equal(r.restored, false, 'it must not claim a restore it could not complete');
        assert.ok(r.problems.some((m) => /index\.lock|Unable to create/.test(m)), JSON.stringify(r.problems));
        assert.ok(fs.readFileSync(ui).equals(original), 'the bytes were put back directly, without git');
      } finally { fs.rmSync(lock, { force: true }); }
    });

    test('a validation run that dirties ANOTHER tracked file: the heal\'s own files are restored, and the leftover is reported, not hidden', async () => {
      const p = makeProject(); const original = fs.readFileSync(path.join(p.proj, 'tests', 'ui.test.js'));
      const r = await run(p, rep(verdict()), async () => { fs.appendFileSync(path.join(p.proj, 'app', 'index.html'), '<!-- the test run wrote this -->\n'); throw new Error('the harness crashed'); });
      assert.equal(r.status, 'reverted');
      assert.equal(r.restored, false, 'the tree is not as it was found, so it says so instead of claiming it is');
      assert.ok(r.problems.includes('the working tree is not clean after the restore'), JSON.stringify(r.problems));
      assert.ok(fs.readFileSync(path.join(p.proj, 'tests', 'ui.test.js')).equals(original));
      assert.equal(git(p.proj, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'and it is back on the original branch');
    });

    test('a pre-commit hook that rejects the commit: reverted and restored, working tree clean (the failure the first version already handled)', async () => {
      const p = makeProject({ hook: '#!/bin/sh\necho "no commits today" >&2\nexit 1\n' }); const before = p.state();
      const r = await run(p, rep(verdict()), async () => ok());
      assert.equal(r.status, 'reverted');
      assert.equal(r.restored, true);
      assert.deepEqual(p.state(), before);
      assert.equal(git(p.proj, 'status', '--porcelain', '--untracked-files=no'), '');
    });
  });

  describe('an interrupt mid-heal reverts first (it used to leave the user on the heal branch with edited files)', () => {
    // a stand-in for `process`: signals are emitted by the test, and "exit" is recorded instead of ending the test run
    const fakeProc = () => { const e = new EventEmitter(); e.exited = null; e.exits = []; e.exit = (c) => { e.exited = c; e.exits.push(c); }; e.stderr = { text: '', write(x) { this.text += x; } }; return e; };
    const stalled = (p, proc) => { // starts a heal whose validation never finishes; resolves once the heal is in the middle of it
      let reached; const at = new Promise((resolve) => { reached = resolve; });
      const done = run(p, rep(verdict()), () => { reached(); return new Promise(() => {}); }, { proc });
      return { at, done };
    };

    for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
      test(`${sig} during validation: the repository is restored, and the process exits ${code}`, async () => {
        const p = makeProject(); const before = p.state(); const proc = fakeProc();
        const { at } = stalled(p, proc);
        await at;
        assert.equal(git(p.proj, 'rev-parse', '--abbrev-ref', 'HEAD'), 'qa/heal-r1', 'the interrupt really does arrive mid-heal');
        assert.match(p.read('tests/ui.test.js'), /getByTestId\('coupon-apply'\)/, 'with the edit applied');
        proc.emit(sig);
        assert.equal(proc.exited, code);
        assert.deepEqual(p.state(), before);
        assert.match(p.read('tests/ui.test.js'), /getByTestId\('coupon-apply-btn'\)/);
        assert.match(proc.stderr.text, new RegExp(`interrupted by ${sig}; the repository was restored exactly as found`));
      });
    }

    test('the handlers are removed when the heal ends, by success or by revert (a long-lived process must not accumulate them)', async () => {
      const proc = fakeProc();
      assert.equal((await run(makeProject(), rep(verdict()), async () => ok(), { proc })).status, 'healed');
      assert.equal(['SIGINT', 'SIGTERM', 'SIGHUP'].reduce((n, s) => n + proc.listenerCount(s), 0), 0);
      assert.equal((await run(makeProject(), rep(verdict()), async () => { throw new Error('x'); }, { proc })).status, 'reverted');
      assert.equal(['SIGINT', 'SIGTERM', 'SIGHUP'].reduce((n, s) => n + proc.listenerCount(s), 0), 0);
    });

    test('no handler is left behind by a refusal either (nothing was changed, so none was ever needed)', async () => {
      const proc = fakeProc(); const p = makeProject(); fs.appendFileSync(path.join(p.proj, 'app', 'index.html'), 'dirty\n');
      assert.equal((await run(p, rep(verdict()), async () => ok(), { proc })).status, 'refused');
      assert.equal(proc.listenerCount('SIGTERM'), 0);
    });

    test('a SECOND signal while the first is being handled does nothing (a real process.exit would end it; this stand-in does not)', async () => {
      const proc = fakeProc(); const p = makeProject(); const before = p.state();
      const { at } = stalled(p, proc);
      await at;
      proc.emit('SIGTERM'); proc.emit('SIGINT'); proc.emit('SIGTERM');
      assert.deepEqual(proc.exits, [143], 'exactly one exit, from the first signal: the heal was already finished with');
      assert.deepEqual(p.state(), before);
      assert.equal(proc.stderr.text.match(/interrupted by/g).length, 1, 'and it reported once');
    });

    test('an interrupt AFTER the heal finished does nothing (it must not revert a heal that is already committed)', async () => {
      const proc = fakeProc(); const p = makeProject();
      assert.equal((await run(p, rep(verdict()), async () => ok(), { proc })).status, 'healed');
      proc.emit('SIGTERM');
      assert.equal(proc.exited, null);
      assert.equal(git(p.proj, 'rev-parse', '--verify', '--quiet', 'refs/heads/qa/heal-r1').length > 0, true, 'the heal branch is still there');
    });
  });

  describe('validation covers every file the heal edited, not only the failing specs', () => {
    const SPEC_B = `const test = require('node:test');\nconst { openPage } = require('./page');\ntest('DEMO-777/TC-001: the other page still has its button', () => { openPage().getByTestId('coupon-apply-btn'); });\n`;
    const two = (specs) => specs.map((s) => path.relative(process.cwd(), s)).sort();

    test('a second SPEC that gets renamed too is re-run with the failing one (the validator is handed both)', async () => {
      const p = makeProject({ files: { 'tests/other.test.js': SPEC_B } });
      const realProj = fs.realpathSync(p.proj); // the validator is handed real paths, one spelling per file
      let asked; const r = await run(p, rep(verdict()), async (specs) => { asked = specs.map((x) => path.relative(realProj, x)).sort(); return ok(); });
      assert.equal(r.status, 'healed', JSON.stringify(r));
      assert.deepEqual(asked, ['tests/other.test.js', 'tests/ui.test.js']);
      assert.deepEqual(r.validated.specs.slice().sort(), ['tests/other.test.js', 'tests/ui.test.js']);
      assert.equal(r.validated.scope, 'specs');
    });

    test('a SHARED HELPER (a page object) that gets edited makes the validation re-run the whole selection, not a guess at which specs use it', async () => {
      const p = makeProject({ files: { 'tests/pages/cart.page.js': "exports.applyButton = (page) => page.getByTestId('coupon-apply-btn');\n" } });
      let asked; const r = await run(p, rep(verdict()), async (specs) => { asked = specs; return ok(); });
      assert.equal(r.status, 'healed', JSON.stringify(r));
      assert.deepEqual(asked, [], 'an empty list means: the same selection as the main run');
      assert.deepEqual([r.validated.scope, r.validated.specs], ['selection', []]);
      assert.match(git(p.proj, 'log', '-1', '--format=%B', 'qa/heal-r1'), /Validated by re-running the whole selection \(a shared helper was edited\)/);
    });

    test('a test that was NOT failing before (it passed, or it never ran) and fails after the rename is a regression: reverted', async () => {
      const p = makeProject({ files: { 'tests/other.test.js': SPEC_B } }); const before = p.state();
      const broke = ok(); broke.tests.push({ name: 'DEMO-777/TC-001: the other page still has its button', ticket: 'DEMO-777', caseId: 'TC-001', file: 'tests/other.test.js', status: 'failed' });
      const r = await run(p, rep(verdict()), async () => broke);
      assert.equal(r.status, 'reverted');
      assert.match(r.reason, /the rename broke DEMO-777\/TC-001, which had not failed before/);
      assert.deepEqual(p.state(), before);
    });

    test('a test that was already failing before is not blamed on the heal', async () => {
      const p = makeProject();
      const r = await run(p, rep(verdict()), async () => { const x = ok(); x.tests[1].status = 'failed'; return x; }, { mainRun: { tests: [{ name: 'DEMO-101/TC-902: y', ticket: 'DEMO-101', caseId: 'TC-902', file: 'tests/ui.test.js', status: 'failed' }] } });
      assert.equal(r.status, 'healed', JSON.stringify(r));
    });
  });

  describe('chained renames are refused (applied in turn they rewrite each other)', () => {
    const chain = (a, b, c) => [verdict({ key: 'DEMO-101/TC-901', proposal: { kind: 'rename-testid', from: a, to: b, similarity: 0.8 } }), verdict({ key: 'DEMO-101/TC-902', test: { name: 'DEMO-101/TC-902: y', ticket: 'DEMO-101', caseId: 'TC-902', file: 'tests/ui.test.js' }, proposal: { kind: 'rename-testid', from: b, to: c, similarity: 0.8 } })];

    test('step-1 -> step-2 together with step-2 -> step-3: refused, and nothing is written', async () => {
      const p = makeProject({ files: { 'tests/steps.test.js': "page.getByTestId('step-1');\npage.getByTestId('step-2');\n" } }); const before = p.state();
      const r = await run(p, rep(...chain('step-1', 'step-2', 'step-3')), async () => ok());
      assert.equal(r.status, 'refused');
      assert.match(r.reason, /"step-1" would be renamed to "step-2", which is itself being renamed in the same heal; applied in turn they would rewrite each other/);
      assert.deepEqual(p.state(), before);
      assert.match(p.read('tests/steps.test.js'), /step-1.*\n.*step-2/);
    });

    test('two UNRELATED renames in one heal are still fine', async () => {
      const p = makeProject({ files: { 'tests/steps.test.js': "page.getByTestId('step-1');\npage.getByTestId('pay-now');\n" } });
      const second = verdict({ key: 'DEMO-101/TC-902', test: { name: 'DEMO-101/TC-902: y', ticket: 'DEMO-101', caseId: 'TC-902', file: 'tests/ui.test.js' }, proposal: { kind: 'rename-testid', from: 'pay-now', to: 'pay-now-btn', similarity: 0.8 } });
      const first = verdict({ proposal: { kind: 'rename-testid', from: 'step-1', to: 'step-one', similarity: 0.8 } });
      const r = await run(p, rep(first, second), async () => ok());
      assert.equal(r.status, 'healed', JSON.stringify(r));
      const healed = git(p.proj, 'show', 'qa/heal-r1:tests/steps.test.js');
      assert.match(healed, /getByTestId\('step-one'\)/);
      assert.match(healed, /getByTestId\('pay-now-btn'\)/);
    });
  });

  describe('a file that is not valid UTF-8 is never rewritten as text', () => {
    const latin1 = (extra) => Buffer.concat([Buffer.from("// caf"), Buffer.from([0xe9]), Buffer.from(` (latin-1)\n${extra}`)]);

    test('invalid bytes on an unrelated line of a file that needs the rename: refused, bytes untouched (they used to become U+FFFD)', async () => {
      const bytes = latin1("page.getByTestId('coupon-apply-btn');\n");
      const p = makeProject({ files: { 'tests/legacy.test.js': bytes } }); const before = p.state();
      const r = await run(p, rep(verdict()), async () => ok());
      assert.equal(r.status, 'refused');
      assert.match(r.reason, /tests\/legacy\.test\.js is not valid UTF-8, so editing it as text would corrupt bytes the heal does not mean to change/);
      assert.ok(fs.readFileSync(path.join(p.proj, 'tests', 'legacy.test.js')).equals(bytes));
      assert.deepEqual(p.state(), before);
      assert.match(p.read('tests/ui.test.js'), /coupon-apply-btn/, 'nothing else was edited either');
    });

    test('a non-UTF-8 file that needs NO change is simply left alone: the heal goes ahead and its bytes are identical afterwards', async () => {
      const bytes = latin1('// nothing to rename here\n');
      const p = makeProject({ files: { 'tests/legacy.test.js': bytes } });
      const r = await run(p, rep(verdict()), async () => ok());
      assert.equal(r.status, 'healed', JSON.stringify(r));
      assert.ok(fs.readFileSync(path.join(p.proj, 'tests', 'legacy.test.js')).equals(bytes));
    });

    test('valid non-ASCII UTF-8 (accents, emoji) and a BOM survive a heal byte for byte, apart from the id', async () => {
      const src = "\uFEFF// café ☕ 😀\nconst test = require('node:test');\ntest('x', () => { page.getByTestId('coupon-apply-btn'); /* ñ */ });\n";
      const p = makeProject({ files: { 'tests/unicode.test.js': src } });
      const r = await run(p, rep(verdict()), async () => ok());
      assert.equal(r.status, 'healed', JSON.stringify(r));
      assert.equal(git(p.proj, 'show', 'qa/heal-r1:tests/unicode.test.js').replace(/^\uFEFF/, ''), src.replace(/^\uFEFF/, '').replace('coupon-apply-btn', 'coupon-apply').trimEnd());
    });
  });

  describe('the report is not taken on trust: a verdict must be what classify.js would have produced', () => {
    const problems = (v, report = {}) => provenanceProblems(report, v);

    test('a genuine verdict has no problems', () => assert.deepEqual(problems(verdict()), []));

    test('each way a report can be wrong is named', () => {
      assert.match(problems(verdict({ class: 'product-bug' })).join(), /its class is "product-bug", not test-bug/);
      assert.match(problems(verdict({ cap: 'unverified-format' })).join(), /held at propose \(unverified-format\)/);
      assert.match(problems(verdict(), { trusted: false }).join(), /its runner format is not trusted/);
      assert.match(problems(verdict({ confidence: 0.99 })).join(), /TST-1 is only ever 0.85, not 0.99/);
      assert.match(problems(verdict({ error: undefined })).join(), /records no error to take the test-id from/);
      assert.match(problems(verdict({ error: { kind: 'failure', message: "locator not found: getByTestId('something-else')" } })).join(), /renames "coupon-apply-btn", but the failure it is based on is about "something-else"/);
      assert.match(problems(verdict({ error: { kind: 'failure', message: 'it just broke' } })).join(), /about "no test-id"/);
      assert.match(problems(verdict({ evidence: ['e'] })).join(), /evidence does not name both the old and the new id/);
      assert.match(problems(verdict({ evidence: ['the test looks for "coupon-apply-btn", which is not on the page'] })).join(), /does not name both/);
    });

    test('the test-id may be in the DETAILS (where Playwright puts it), as the classifier reads both', () => {
      assert.deepEqual(problems(verdict({ error: { kind: 'failure', message: 'expect(locator).toBeVisible()', details: "Locator: getByTestId('coupon-apply-btn')\nReceived: <element(s) not found>" } })), []);
    });

    test('a hand-edited report that renames an arbitrary id is refused before anything is written', async () => {
      const p = makeProject({ files: { 'tests/secret.test.js': "page.getByTestId('checkout-confirm');\n" } }); const before = p.state();
      const forged = verdict({ proposal: { kind: 'rename-testid', from: 'checkout-confirm', to: 'checkout-skip', similarity: 0.8 }, evidence: ['looks legitimate'] });
      const r = await run(p, rep(forged), async () => ok());
      assert.equal(r.status, 'refused');
      assert.match(r.reason, /the report is not what classify\.js would have produced for DEMO-101\/TC-901: .*A heal only acts on a report the classifier wrote/);
      assert.deepEqual(p.state(), before);
    });

    test('END TO END: a TST-1 verdict held at propose because its runner format is unverified is never healed', async () => {
      const t = { name: 'DEMO-101/TC-901: x', ticket: 'DEMO-101', caseId: 'TC-901', file: 'tests/ui.test.js', status: 'failed', error: { kind: 'failure', message: "locator not found: getByTestId('coupon-apply-btn')" } };
      const evidence = { 'DEMO-101/TC-901': { locator: { target: 'coupon-apply-btn', present: false, candidates: [{ testid: 'coupon-apply', similarity: 0.8, tag: 'button', text: 'Apply' }] } } };
      const report = classify({ runs: [1, 2, 3].map(() => ({ format: 'playwright-json', tests: [t] })), evidence });
      assert.deepEqual([report.verdicts[0].rule, report.verdicts[0].confidence, report.verdicts[0].action, report.verdicts[0].cap], ['TST-1', 0.85, 'propose', 'unverified-format']);
      assert.deepEqual(eligible(report), [], 'not eligible');
      const p = makeProject(); const before = p.state();
      const r = await heal({ report, cwd: p.proj, runId: 'r1', paths: ['tests'], validate: async () => ok() });
      assert.equal(r.status, 'nothing-to-heal');
      assert.deepEqual(p.state(), before);
      // and the same verdict from a trusted format is healed (so the cap, not something else, is what stopped it)
      const trusted = classify({ runs: [1, 2, 3].map(() => ({ format: 'tap', tests: [t] })), evidence });
      assert.equal((await heal({ report: trusted, cwd: p.proj, runId: 'r2', paths: ['tests'], validate: async () => ok() })).status, 'healed');
    });
  });

  test('validated.specs are paths inside the repository even when the run directory was reached through a symlink', async () => {
    const p = makeProject(); const link = path.join(p.root, 'via-link'); fs.symlinkSync(p.proj, link);
    const r = await heal({ report: rep(verdict()), cwd: link, runId: 'r1', paths: ['tests'], validate: async () => ok(), mainRun: { tests: [] } });
    assert.equal(r.status, 'healed', JSON.stringify(r));
    assert.deepEqual(r.validated.specs, ['tests/ui.test.js'], 'it used to print ../../../../tmp/... when the path went through a symlink');
  });
});

// What the independent review of this PR found: each of these was a way for a stated guarantee to be false (or an untested guard).
describe('heal(): hardening from the review', () => {
  const verdict = (extra = {}) => ({ key: 'DEMO-101/TC-901', test: { name: 'DEMO-101/TC-901: x', ticket: 'DEMO-101', caseId: 'TC-901', file: 'tests/ui.test.js' }, class: 'test-bug', rule: 'TST-1', confidence: 0.85, action: 'act',
    evidence: ['the test looks for "coupon-apply-btn", which is not on the page, but "coupon-apply" is (similarity 0.8)'], error: { kind: 'failure', message: "locator not found: getByTestId('coupon-apply-btn')" },
    attempts: [], fingerprint: 'a'.repeat(12), token: `qafp${'a'.repeat(12)}`, signature: 's', proposal: { kind: 'rename-testid', from: 'coupon-apply-btn', to: 'coupon-apply', similarity: 0.8 }, ...extra });
  const passing = () => ({ totals: { total: 2, passed: 2, failed: 0, skipped: 0 }, tests: [{ name: 'DEMO-101/TC-901: x', ticket: 'DEMO-101', caseId: 'TC-901', file: 'tests/ui.test.js', status: 'passed' }, { name: 'DEMO-101/TC-902: y', ticket: 'DEMO-101', caseId: 'TC-902', file: 'tests/ui.test.js', status: 'passed' }] });
  const run = (p, v, validate = async () => passing(), opts = {}) => heal({ report: { verdicts: [v] }, cwd: p.proj, runId: 'r1', paths: ['tests'], validate, mainRun: { tests: [] }, ...opts });

  test('a base branch whose name a shell would interpret is refused: the review command and the push steps put it on a command line', async () => {
    const p = makeProject();
    git(p.proj, 'switch', '-c', 'x$(touch${IFS}PWNED)');
    const before = p.state();
    const r = await run(p, verdict());
    assert.equal(r.status, 'refused');
    assert.match(r.reason, /branch name/);
    assert.deepEqual(p.state(), before);
    assert.equal(fs.existsSync(path.join(p.proj, 'PWNED')), false);
  });

  test('a hard-linked test file is not edited: writing it in place would change the file it is linked to, outside any check', async () => {
    const p = makeProject({ files: { 'src/app.js': "openPage().getByTestId('coupon-apply-btn');\n" } });
    fs.linkSync(path.join(p.proj, 'src', 'app.js'), path.join(p.proj, 'tests', 'hl.test.js'));
    git(p.proj, 'add', '-A'); git(p.proj, 'commit', '-q', '-m', 'link');
    const r = await run(p, verdict());
    assert.equal(r.status, 'healed', JSON.stringify(r));
    assert.equal(p.read('src/app.js'), "openPage().getByTestId('coupon-apply-btn');\n", 'the application file is exactly as it was');
    assert.equal(git(p.proj, 'status', '--porcelain', '--untracked-files=no'), '');
    assert.ok(r.notScanned.some((n) => n.file === 'tests/hl.test.js' && /hard link/.test(n.reason)), JSON.stringify(r.notScanned));
    assert.deepEqual(r.changes.map((c) => c.file), ['tests/ui.test.js'], 'only the ordinary file was edited');
  });

  test('a spec the report names must be inside the test directories, not merely inside the repository (a report is not trusted)', async () => {
    const p = makeProject({ files: { 'scripts/danger.js': 'throw new Error("must never run");\n' } });
    const before = p.state();
    const r = await run(p, verdict({ test: { name: 'x', ticket: 'DEMO-101', caseId: 'TC-901', file: 'scripts/danger.js' } }));
    assert.equal(r.status, 'refused');
    assert.match(r.reason, /outside the test directories/);
    assert.deepEqual(p.state(), before);
  });

  test('…and a sibling directory that merely starts with the same name is outside the repository, for the spec and for a configured path', async () => {
    const p = makeProject();
    const evil = path.join(p.root, 'proj-evil'); fs.mkdirSync(evil); fs.writeFileSync(path.join(evil, 'x.test.js'), "getByTestId('coupon-apply-btn');\n");
    const viaSpec = await run(p, verdict({ test: { name: 'x', ticket: 'DEMO-101', caseId: 'TC-901', file: '../proj-evil/x.test.js' } }));
    assert.equal(viaSpec.status, 'refused');
    assert.match(viaSpec.reason, /outside the repository/);
    const viaPath = await run(p, verdict(), async () => passing(), { paths: ['../proj-evil'] });
    assert.equal(viaPath.status, 'refused');
    assert.match(viaPath.reason, /resolves outside the repository/);
    assert.equal(fs.readFileSync(path.join(evil, 'x.test.js'), 'utf8'), "getByTestId('coupon-apply-btn');\n");
  });

  test('a run id with characters a branch name cannot hold is made safe, not refused', async () => {
    const p = makeProject();
    const r = await run(p, verdict(), async () => passing(), { runId: 'a b;$(x)' });
    assert.equal(r.status, 'healed', JSON.stringify(r));
    assert.equal(r.branch, 'qa/heal-a-b-x');
  });

  test('when the heal has COMMITTED and a later step fails, its own branch goes too (it holds nothing but the heal\'s commit)', async () => {
    const p = makeProject();
    // git reports a failing post-checkout hook as a failed switch: here only the switch back to main, once the heal branch is ahead of it
    fs.writeFileSync(path.join(p.proj, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\n[ "$(git rev-parse --abbrev-ref HEAD)" = main ] && git rev-parse -q --verify refs/heads/qa/heal-r1 >/dev/null && [ "$(git rev-parse qa/heal-r1)" != "$(git rev-parse main)" ] && exit 1\nexit 0\n', { mode: 0o755 });
    const r = await run(p, verdict());
    assert.equal(r.status, 'reverted', JSON.stringify(r));
    assert.doesNotMatch(p.state().branches, /qa\/heal-r1/, 'the heal\'s own commit and branch are gone');
    assert.equal(p.state().head, git(p.proj, 'rev-parse', 'main'));
    assert.match(p.read('tests/ui.test.js'), /coupon-apply-btn/, 'the file holds its original id');
  });

  test('a commit that is not the heal\'s own is never thrown away with its branch: only a branch at the base, or at the heal\'s own commit, is deleted', async () => {
    const p = makeProject();
    const r = await run(p, verdict(), async () => {
      git(p.proj, 'commit', '--allow-empty', '-q', '-m', 'someone else committed here during the validation');
      const bad = passing(); bad.tests[0].status = 'failed'; return bad;
    });
    assert.equal(r.status, 'reverted');
    assert.equal(r.restored, true);
    assert.match(p.state().branches, /qa\/heal-r1/, 'the branch holding that commit is kept');
    assert.equal(p.state().branch, 'main');
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
    // ls-files only READS which files git tracks (a heal edits tracked files only); nothing here touches a remote
    assert.deepEqual([...new Set(gitCalls)].sort(), ['add', 'branch', 'checkout', 'commit', 'ls-files', 'rev-parse', 'status', 'switch'], 'the complete list of git subcommands it can run, all local');
  });
});

// ── the CLI ──────────────────────────────────────────────────────────────────────────────────────
describe('heal CLI', () => {
  // Hermetic: unless a test names its own --config, point the CLI at an empty one, so a developer's own ./qa-config.json (which may have
  // triage.selfHeal.enabled set) cannot change what these tests expect. tests/triage/hermetic.test.js proves it.
  const EMPTY_CFG = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-heal-cfg-')), 'empty-config.json'); fs.writeFileSync(EMPTY_CFG, '{}');
  const cli = async (argv, runResults) => { let out = ''; let err = ''; const code = await healCli({ argv: argv.length && !argv.includes('--config') && !argv.includes('-h') && !argv.includes('--help') ? [...argv, '--config', EMPTY_CFG] : argv, env: baseEnv(), stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, ...(runResults ? { runResults } : {}) }); return { code, err, json: out ? JSON.parse(out) : null }; };
  const reportFor = (p) => {
    const t = (status, extra = {}) => ({ name: 'DEMO-101/TC-901: the Apply button is on the cart panel', ticket: 'DEMO-101', caseId: 'TC-901', file: path.join(p.proj, 'tests', 'ui.test.js'), status, ...extra });
    const stale = { kind: 'failure', message: "locator not found: getByTestId('coupon-apply-btn')" };
    // 'tap' is trusted by default; a result with no format, or an unverified one, is held at propose and never healed (tested below)
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
    const r = await cli(['--report', reportFor(p), '--main', mainRun, '--framework', 'node', '--cwd', p.proj, '--paths', 'tests', '--apply', '--enable', '--run-id', 'cli1', '--out', out], async () => ({ code: 0, doc: { ok: true, data: pass } }));
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.equal(r.json.data.branch, 'qa/heal-cli1');
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), r.json);
  });

  // ── "off unless enabled" is a property of the heal, not only of the orchestrator ──
  const applyArgv = (p, extra = []) => ['--report', reportFor(p), '--main', path.join(p.root, 'main.json'), '--framework', 'node', '--cwd', p.proj, '--paths', 'tests', '--apply', ...extra];
  const passAll = async () => ({ code: 0, doc: { ok: true, data: { totals: { passed: 1, failed: 0 }, tests: [{ name: 'DEMO-101/TC-901: the Apply button is on the cart panel', ticket: 'DEMO-101', caseId: 'TC-901', file: 'tests/ui.test.js', status: 'passed' }] } } });

  test('--apply is refused while self-heal is off: nothing is changed, and the reason says how to turn it on', async () => {
    const p = makeProject(); const before = p.state();
    fs.writeFileSync(path.join(p.root, 'main.json'), JSON.stringify({ tests: [] }));
    for (const config of [[], ['--config', p.cfg({ selfHeal: { enabled: false } })], ['--config', p.cfg({})]]) {
      const r = await cli(applyArgv(p, config), passAll);
      assert.equal(r.code, 1);
      assert.equal(r.json.data.status, 'refused');
      assert.match(r.json.data.reason, /self-heal is off \(triage\.selfHeal\.enabled in qa-config\.json\)\. Enable it there, or pass --enable/);
      assert.deepEqual(p.state(), before);
      assert.match(p.read('tests/ui.test.js'), /coupon-apply-btn/, 'the file was not touched');
    }
  });

  test('--apply works when the config enables self-heal, and when --enable says so for this run', async () => {
    for (const extra of [['--config', 'ENABLED'], ['--enable']]) {
      const p = makeProject();
      fs.writeFileSync(path.join(p.root, 'main.json'), JSON.stringify({ tests: [] }));
      const argv = applyArgv(p, extra.map((x) => (x === 'ENABLED' ? p.cfg({ selfHeal: { enabled: true } }) : x)));
      const r = await cli(argv, passAll);
      assert.equal(r.code, 0, JSON.stringify(r.json));
      assert.equal(r.json.data.status, 'healed');
    }
  });

  test('a preview never needs self-heal to be enabled (it writes nothing), and --enable alone is a usage error', async () => {
    const p = makeProject();
    const preview = await cli(['--report', reportFor(p), '--cwd', p.proj, '--paths', 'tests', '--config', p.cfg({ selfHeal: { enabled: false } })]);
    assert.equal(preview.code, 0);
    assert.equal(preview.json.data.status, 'preview');
    const r = await cli(['--report', reportFor(p), '--enable']);
    assert.equal(r.code, 2);
    assert.match(r.err, /--enable only means something with --apply/);
  });

  test('--max-files and --max-lines may tighten a cap but never lift it past the bounds the config and schema enforce (20 files, 200 lines)', async () => {
    const p = makeProject();
    for (const [flag, ok, tooBig] of [['--max-files', '20', '21'], ['--max-lines', '200', '201']]) {
      assert.notEqual((await cli(['--report', reportFor(p), flag, ok, '--cwd', p.proj, '--paths', 'tests'])).code, 2, `${flag} ${ok} is allowed`);
      const r = await cli(['--report', reportFor(p), flag, tooBig]);
      assert.equal(r.code, 2, `${flag} ${tooBig}`);
      assert.match(r.err, new RegExp(`${flag} must be a whole number from 1 to ${ok}`));
    }
    assert.equal((await cli(['--report', reportFor(p), '--max-files', '1000'])).code, 2);
  });


  // A spec that says it has started (a sentinel file outside the repository), then waits: the test knows the validation run is genuinely in
  // progress instead of guessing with a sleep, and the run is bounded (60 s) if nothing ever kills it.
  const slowSpec = (started, extra = '') => UI_TEST + `\ntest('slow: keeps the validation re-run busy', async () => { ${extra} require('fs').writeFileSync(${JSON.stringify(started)}, '1'); await new Promise((resolve) => setTimeout(resolve, 60000)); });\n`;
  const until = async (what, ok, ms = 30000, seen) => { const end = Date.now() + ms; while (Date.now() < end) { if (ok()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail(`timed out waiting for ${what}${seen ? ` (stdout: ${seen.stdout.slice(0, 600)} stderr: ${seen.stderr.slice(0, 300)})` : ''}`); };
  const spawnHeal = (p, runId, extraArgs = []) => {
    const mainRun = path.join(p.root, 'main.json'); fs.writeFileSync(mainRun, JSON.stringify({ tests: [] }));
    const script = path.join(__dirname, '..', '..', 'scripts', 'triage', 'heal.js');
    const child = spawn(process.execPath, [script, '--report', reportFor(p), '--main', mainRun, '--framework', 'node', '--cwd', p.proj, '--paths', 'tests', '--apply', '--enable', '--run-id', runId, '--config', EMPTY_CFG, ...extraArgs], { env: baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const seen = { stderr: '', stdout: '' }; child.stderr.on('data', (d) => { seen.stderr += d; }); child.stdout.on('data', (d) => { seen.stdout += d; });
    seen.exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    return { child, seen };
  };

  test('a REAL SIGTERM sent to a running heal.js (a killed agent, a CI timeout) restores the repository before the process exits', async () => {
    const started = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-heal-sig-')), 'started');
    const p = makeProject({ files: { 'tests/ui.test.js': slowSpec(started) } }); const before = p.state(); const original = fs.readFileSync(path.join(p.proj, 'tests', 'ui.test.js'));
    const { child, seen } = spawnHeal(p, 'sig1');
    await until('the validation run to start', () => fs.existsSync(started), 30000, seen);
    child.kill('SIGTERM');
    const { code, signal } = await seen.exited;
    assert.deepEqual([code, signal], [143, null], 'it reverted and exited by itself with 128 + SIGTERM, instead of being killed with the repository mid-change');
    assert.match(seen.stderr, /heal: interrupted by SIGTERM; the repository was restored exactly as found/);
    assert.deepEqual(p.state(), before);
    assert.ok(fs.readFileSync(path.join(p.proj, 'tests', 'ui.test.js')).equals(original), 'the file holds its original bytes');
    assert.equal(git(p.proj, 'status', '--porcelain', '--untracked-files=no'), '');
  });

  test('a runner that IGNORES SIGTERM is still stopped before the repository is put back, so it cannot write into it afterwards', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-heal-trap-'));
    const started = path.join(dir, 'started'); const late = path.join(dir, 'late-write');
    const trap = `process.on('SIGTERM', () => {}); setTimeout(() => require('fs').writeFileSync(${JSON.stringify(late)}, 'x'), 2500);`;
    const p = makeProject({ files: { 'tests/ui.test.js': slowSpec(started, trap) } });
    const { child, seen } = spawnHeal(p, 'trap1');
    await until('the validation run to start', () => fs.existsSync(started), 30000, seen);
    child.kill('SIGTERM');
    assert.deepEqual(await seen.exited, { code: 143, signal: null });
    await new Promise((r) => setTimeout(r, 3500));
    assert.equal(fs.existsSync(late), false, 'the runner outlived the revert and wrote after it');
  });

  test('a SIGTERM that arrives DURING the revert after a failed validation is not fatal: the revert finishes, then the process exits', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-heal-rev-'));
    const marker = path.join(dir, 'validated'); const running = path.join(dir, 'reverting');
    // the second test fails, so the validation fails and the heal is reverted; the hook then makes every checkout slow, but only once the validation has run
    const failing = UI_TEST + `\ntest('fails: forces the validation to fail', () => { require('fs').writeFileSync(${JSON.stringify(marker)}, '1'); throw new Error('boom'); });\n`;
    const p = makeProject({ files: { 'tests/ui.test.js': failing } }); const before = p.state();
    fs.writeFileSync(path.join(p.proj, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\nif [ -f ${JSON.stringify(marker)} ]; then touch ${JSON.stringify(running)}; sleep 1; fi\n`, { mode: 0o755 });
    const { child, seen } = spawnHeal(p, 'rev1');
    await until('the revert to begin', () => fs.existsSync(running), 30000, seen);
    child.kill('SIGTERM');
    const { code, signal } = await seen.exited;
    assert.deepEqual([code, signal], [143, null], `the interrupt waited for the revert instead of killing the process in the middle of it (stdout: ${seen.stdout.slice(0, 500)} stderr: ${seen.stderr.slice(0, 300)})`);
    assert.match(seen.stderr, /interrupted by SIGTERM; the repository was restored exactly as found/);
    assert.deepEqual(p.state(), before);
  });

  test('a report with no runner format is refused for --apply: removing "format" must not skip the project\'s trust setting', async () => {
    const p = makeProject();
    const doc = JSON.parse(fs.readFileSync(reportFor(p), 'utf8')); delete doc.data.format; delete doc.data.trusted;
    const f = path.join(p.root, 'no-format.json'); fs.writeFileSync(f, JSON.stringify(doc));
    const mainRun = path.join(p.root, 'main.json'); fs.writeFileSync(mainRun, JSON.stringify({ tests: [] }));
    const before = p.state();
    const r = await cli(['--report', f, '--main', mainRun, '--framework', 'node', '--cwd', p.proj, '--paths', 'tests', '--apply', '--enable'], async () => assert.fail('nothing may be re-run for a refused heal'));
    assert.equal(r.code, 1);
    assert.match(r.json.data.reason, /does not say which runner format/);
    assert.deepEqual(p.state(), before);
  });

  test('--paths may narrow the configured test directories but never name one the config does not: a flag cannot lift the scope', async () => {
    const p = makeProject({ files: { 'e2e/extra.test.js': '// x\n' } });
    const cfg = p.cfg({ selfHeal: { paths: ['tests'] } });
    const outside = await cli(['--report', reportFor(p), '--cwd', p.proj, '--config', cfg, '--paths', 'app']);
    assert.equal(outside.code, 2);
    assert.match(outside.err, /--paths app is not inside the test directories the config names \(tests\)/);
    const sibling = await cli(['--report', reportFor(p), '--cwd', p.proj, '--config', cfg, '--paths', 'tests-evil']);
    assert.equal(sibling.code, 2, 'a name that merely starts with a configured one is not inside it');
    assert.notEqual((await cli(['--report', reportFor(p), '--cwd', p.proj, '--config', cfg, '--paths', 'tests'])).code, 2);
    assert.notEqual((await cli(['--report', reportFor(p), '--cwd', p.proj, '--config', cfg, '--paths', 'tests/sub'])).code, 2, 'a subdirectory narrows it');
  });

  test('--max-lines cannot lift the configured cap: the lower of the two applies', async () => {
    const twice = UI_TEST + "\ntest('DEMO-101/TC-903: again', () => { openPage().getByTestId('coupon-apply-btn'); });\n";
    const p = makeProject({ files: { 'tests/ui.test.js': twice } });
    const cfg = p.cfg({ selfHeal: { paths: ['tests'], maxLines: 1 } });
    const r = await cli(['--report', reportFor(p), '--cwd', p.proj, '--config', cfg, '--max-lines', '50']);
    assert.equal(r.json.data.status, 'refused');
    assert.match(r.json.data.reason, /more than the limit of 1 \(triage\.selfHeal\.maxLines\)/);
  });

  test('a refusal exits 1 with the reason; bad input exits 2 or 1 naming the file', async () => {
    const p = makeProject();
    fs.appendFileSync(path.join(p.proj, 'app', 'index.html'), 'dirty\n');
    const mainRun = path.join(p.root, 'main.json'); fs.writeFileSync(mainRun, JSON.stringify({ tests: [] }));
    const r = await cli(['--report', reportFor(p), '--main', mainRun, '--framework', 'node', '--cwd', p.proj, '--paths', 'tests', '--apply', '--enable'], async () => ({ code: 0, doc: { ok: true, data: { tests: [] } } }));
    assert.equal(r.code, 1);
    assert.equal(r.json.data.status, 'refused');
    assert.match(r.json.data.reason, /uncommitted changes to tracked files/, 'refused for the reason this test is about, not because self-heal is off');
    assert.equal((await cli(['--report', path.join(p.root, 'nope.json')])).json.error.code, 'UNREADABLE');
    const bad = path.join(p.root, 'bad.json'); fs.writeFileSync(bad, '{"x":1}');
    assert.match((await cli(['--report', bad])).json.error.message, /no "verdicts" array/);
    for (const argv of [[], ['--bogus'], ['--report'], ['--report', 'x', '--max-files', '0'], ['--report', 'x', '--max-lines', 'abc']]) assert.equal((await cli(argv)).code, 2, argv.join(' '));
  });
});

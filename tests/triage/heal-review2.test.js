'use strict';

// Findings from the second independent review of the self-heal PR. Each test failed on the code it was written against. Everything runs in
// throwaway git repositories (never the real one), with the real git and, where it matters, the real runner and a real SIGTERM.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { main: healCli, heal } = require('../../scripts/triage/heal');
const core = require('../../scripts/triage/lib/heal-core');
const { classify } = require('../../scripts/triage/classify');

const IDENT = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test' };
const baseEnv = () => { const e = { ...process.env, ...IDENT }; delete e.NODE_TEST_CONTEXT; return e; };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: baseEnv() }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function makeProject({ files = {}, extraGit = () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-heal2-'));
  const proj = path.join(root, 'proj');
  const w = (rel, content) => { const f = path.join(proj, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };
  w('app/index.html', INDEX); w('tests/page.js', PAGE_JS); w('tests/ui.test.js', UI_TEST);
  for (const [rel, content] of Object.entries(files)) w(rel, content);
  git(proj, 'init', '-q', '-b', 'main'); git(proj, 'add', '-A'); git(proj, 'commit', '-q', '-m', 'initial');
  extraGit(proj);
  const state = () => ({ head: git(proj, 'rev-parse', 'HEAD'), branch: git(proj, 'branch', '--show-current'), branches: git(proj, 'branch', '--format=%(refname:short)'), status: git(proj, 'status', '--porcelain', '--untracked-files=no') });
  return { root, proj, w, state, read: (rel) => fs.readFileSync(path.join(proj, rel), 'utf8') };
}

const verdict = (extra = {}) => {
  const proposal = extra.proposal || { kind: 'rename-testid', from: 'coupon-apply-btn', to: 'coupon-apply', similarity: 0.8 };
  return { key: 'DEMO-101/TC-901', test: { name: 'DEMO-101/TC-901: x', ticket: 'DEMO-101', caseId: 'TC-901', file: 'tests/ui.test.js' }, class: 'test-bug', rule: 'TST-1', confidence: 0.85, action: 'act',
    evidence: [`the test looks for "${proposal.from}", which is not on the page, but "${proposal.to}" is (similarity 0.8)`], error: { kind: 'failure', message: `locator not found: getByTestId('${proposal.from}')` },
    attempts: [], fingerprint: 'a'.repeat(12), token: `qafp${'a'.repeat(12)}`, signature: 's', proposal, ...extra };
};
const rep = (...v) => ({ verdicts: v });
const ok = () => ({ totals: { total: 2, passed: 2, failed: 0, skipped: 0 }, tests: [{ name: 'DEMO-101/TC-901: x', ticket: 'DEMO-101', caseId: 'TC-901', file: 'tests/ui.test.js', status: 'passed' }, { name: 'DEMO-101/TC-902: y', ticket: 'DEMO-101', caseId: 'TC-902', file: 'tests/ui.test.js', status: 'passed' }] });
const run = (p, report, validate, opts = {}) => heal({ report, cwd: p.proj, runId: 'r1', paths: ['tests'], validate, mainRun: { tests: [] }, ...opts });

describe('a tag named like the base branch (review: left the user on the heal branch, and said "restored")', () => {
  test('with a tag called "main" beside the branch "main", a validated heal lands and HEAD goes back to main', async () => {
    const p = makeProject({ extraGit: (d) => git(d, 'tag', 'main') });
    const r = await run(p, rep(verdict()), async () => ok());
    assert.equal(r.status, 'healed', JSON.stringify(r));
    assert.equal(r.base, 'main');
    assert.equal(p.state().branch, 'main');
    assert.equal(p.state().status, '', 'nothing left staged');
  });

  test('...and a failed validation with that tag reverts completely, and the result says restored', async () => {
    const p = makeProject({ extraGit: (d) => git(d, 'tag', 'main') });
    const before = p.state();
    const r = await run(p, rep(verdict()), async () => { throw new Error('boom'); });
    assert.equal(r.status, 'reverted');
    assert.equal(r.restored, true, JSON.stringify(r));
    assert.deepEqual(p.state(), before);
    assert.match(p.read('tests/ui.test.js'), /coupon-apply-btn/);
  });
});

describe('a tag named like the heal branch (the revert must delete the BRANCH it made, not trust an ambiguous name)', () => {
  test('a failed validation still removes qa/heal-r1 when a tag of that name points elsewhere', async () => {
    const p = makeProject({ extraGit: (d) => { git(d, 'commit', '-q', '--allow-empty', '-m', 'later'); git(d, 'tag', 'qa/heal-r1', 'HEAD~1'); } });
    const before = p.state();
    const r = await run(p, rep(verdict()), async () => { throw new Error('boom'); });
    assert.equal(r.status, 'reverted');
    assert.equal(r.restored, true, JSON.stringify(r));
    assert.deepEqual(p.state(), before, 'the heal branch must be gone: git resolves the bare name to the tag, whose commit is not the base');
    assert.equal(git(p.proj, 'branch', '--list', 'qa/heal-r1'), '', 'no branch of that name is left behind');
  });
});

describe('the orchestrator does not claim a restore the heal says it did not make (review)', () => {
  const { healWarning } = require('../../scripts/triage/orchestrate');
  test('restored: false is reported as NOT restored, with the problems', () => {
    const w = healWarning({ status: 'reverted', reason: 'boom', restored: false, problems: ['git switch failed: x'] });
    assert.doesNotMatch(w, /the repository was restored\)/);
    assert.match(w, /NOT fully restored/);
    assert.match(w, /git switch failed: x/);
  });
  test('a clean revert still says it was restored', () => {
    assert.match(healWarning({ status: 'reverted', reason: 'boom', restored: true }), /the repository was restored/);
  });
  test('a refusal says nothing about restoring (nothing was changed)', () => {
    assert.equal(healWarning({ status: 'refused', reason: 'nope' }), 'self-heal refused: nope');
  });
});

describe('the report is not taken on trust: the spec to re-run must be inside the repository (review)', () => {
  const outside = () => {
    const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-heal2-outside-'));
    const marker = path.join(d, 'ran');
    fs.writeFileSync(path.join(d, 'evil.test.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); require('node:test')('x', () => {});\n`);
    return { file: path.join(d, 'evil.test.js'), marker };
  };
  for (const [label, file] of [['an absolute path outside the repository', () => outside().file], ['a ../ path out of the repository', () => '../../../../../../../../../tmp']]) {
    test(`test.file = ${label}: refused, nothing validated, nothing changed`, async () => {
      const p = makeProject(); const before = p.state(); const asked = [];
      const v = verdict(); v.test = { ...v.test, file: file() };
      const r = await run(p, rep(v), async (specs) => { asked.push(specs); return ok(); });
      assert.equal(r.status, 'refused', JSON.stringify(r));
      assert.match(r.reason, /outside the repository/);
      assert.deepEqual(asked, [], 'the validation run was never started');
      assert.deepEqual(p.state(), before);
    });
  }
});

describe('a branch that cannot be created is a refusal, not a revert with a made-up problem (review)', () => {
  for (const [label, runId, setup] of [['a run id git rejects (x.lock)', 'x.lock', () => {}], ['a run id with ..', 'a..b', () => {}], ['an existing branch called qa (blocks qa/heal-*)', 'r1', (d) => git(d, 'branch', 'qa')]]) {
    test(label, async () => {
      const p = makeProject({ extraGit: setup }); const before = p.state();
      const r = await run(p, rep(verdict()), async () => ok(), { runId });
      assert.equal(r.status, 'refused', JSON.stringify(r));
      assert.equal(r.problems, undefined, 'there was nothing to restore, so there are no restore problems');
      assert.deepEqual(p.state(), before);
      assert.match(p.read('tests/ui.test.js'), /coupon-apply-btn/);
    });
  }
});

describe('what the heal could not see is reported (review)', () => {
  test('a stale id that lives only in a constant: nothing to heal, but the leftover is named', async () => {
    const p = makeProject({ files: { 'tests/ui.test.js': "const test = require('node:test');\nconst APPLY = 'coupon-apply-btn';\ntest('x', () => { getByTestId(APPLY); });\n" } });
    const r = await run(p, rep(verdict()), async () => ok());
    assert.equal(r.status, 'nothing-to-heal');
    assert.equal(r.leftovers.length, 1);
    assert.match(r.leftovers[0].text, /APPLY = 'coupon-apply-btn'/);
  });

  test('a file over the size cap, and a symlink, are named as not scanned instead of vanishing', async () => {
    const p = makeProject({ files: { 'tests/big.js': `${'/* padding */\n'.repeat(90000)}openPage().getByTestId('coupon-apply-btn');\n` } });
    fs.symlinkSync('ui.test.js', path.join(p.proj, 'tests', 'alias.test.js')); git(p.proj, 'add', '-A'); git(p.proj, 'commit', '-q', '-m', 'more');
    const r = await run(p, rep(verdict()), async () => ok());
    assert.equal(r.status, 'healed', JSON.stringify(r));
    const names = (r.notScanned || []).map((n) => `${n.file}: ${n.reason}`).sort();
    assert.equal(names.length, 2, JSON.stringify(r.notScanned));
    assert.match(names[0], /tests\/alias\.test\.js: a symlink/);
    assert.match(names[1], /tests\/big\.js: larger than 1 MB/);
  });
});

describe('the edit stays in test code (review)', () => {
  test('a commented-out locator is not rewritten (it is reported as a leftover)', async () => {
    const p = makeProject({ files: { 'tests/ui.test.js': `${UI_TEST}\n// openPage().getByTestId('coupon-apply-btn');\n` } });
    const r = await run(p, rep(verdict()), async () => ok());
    assert.equal(r.status, 'healed', JSON.stringify(r));
    assert.match(git(p.proj, 'show', 'qa/heal-r1:tests/ui.test.js'), /\/\/ openPage\(\)\.getByTestId\('coupon-apply-btn'\)/, 'the comment keeps the old id');
    assert.equal(r.leftovers.length, 1);
  });

  for (const line of ["# page.get_by_test_id('coupon-apply-btn')", " * getByTestId('coupon-apply-btn')", "/* getByTestId('coupon-apply-btn') */"]) {
    test(`comment forms are skipped by the edit itself: ${line.trim().slice(0, 22)}…`, () => {
      assert.deepEqual(core.replaceInLocators(line, 'coupon-apply-btn', 'coupon-apply').changes, []);
    });
  }

  test('a code line is still rewritten (the comment rule must not swallow real locators)', () => {
    assert.equal(core.replaceInLocators("  openPage().getByTestId('coupon-apply-btn'); // was a button", 'coupon-apply-btn', 'coupon-apply').changes.length, 1);
  });

  test('a heal path that is the repository root is refused: that would put application code in scope', async () => {
    const p = makeProject({ files: { 'src/analytics.js': "track(getByTestId('coupon-apply-btn'));\n" } });
    const before = p.state();
    for (const dot of ['.', './', 'tests/..']) {
      const r = await run(p, rep(verdict()), async () => ok(), { paths: [dot] });
      assert.equal(r.status, 'refused', `${dot}: ${JSON.stringify(r)}`);
      assert.match(r.reason, /repository root|name the test directories/);
    }
    assert.deepEqual(p.state(), before);
    assert.match(p.read('src/analytics.js'), /coupon-apply-btn/);
  });
});

describe('test-id validation: a quote alone is enough to refuse (review: mutation survivor)', () => {
  for (const id of ["a'b", 'a"b', 'a`b', 'a\\b', 'a$b', 'a b', 'a\nb', 'a;b', 'a)b', 'a]b', '']) {
    test(`${JSON.stringify(id)} is not a safe id`, () => assert.equal(core.isSafeTestId(id), false));
  }
  for (const id of ['coupon-apply', 'a_b', 'a.b', 'a:b', 'A1']) {
    test(`${JSON.stringify(id)} is`, () => assert.equal(core.isSafeTestId(id), true));
  }
});

// ── the CLI ───────────────────────────────────────────────────────────────────
describe('heal CLI: the same limits as the orchestrator (review)', () => {
  const cfgFile = (root, doc) => { const f = path.join(root, `cfg-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(doc)); return f; };
  const cli = async (argv, runResults) => { let out = ''; let err = ''; const code = await healCli({ argv, env: baseEnv(), stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, ...(runResults ? { runResults } : {}) }); return { code, err, json: out ? JSON.parse(out) : null }; };
  const reportFile = (p, { format = 'tap' } = {}) => {
    const t = (status, extra = {}) => ({ name: 'DEMO-101/TC-901: x', ticket: 'DEMO-101', caseId: 'TC-901', file: path.join(p.proj, 'tests', 'ui.test.js'), status, ...extra });
    const stale = { kind: 'failure', message: "locator not found: getByTestId('coupon-apply-btn')" };
    const r = classify({ runs: [1, 2, 3].map(() => ({ format, tests: [t('failed', { error: stale })] })), trustedFormats: [format], evidence: { 'DEMO-101/TC-901': { locator: { target: 'coupon-apply-btn', present: false, candidates: [{ testid: 'coupon-apply', similarity: 0.8 }] } } } });
    const f = path.join(p.root, 'triage.json'); fs.writeFileSync(f, JSON.stringify({ ok: true, data: r })); return f;
  };
  const mainFile = (p) => { const f = path.join(p.root, 'main.json'); fs.writeFileSync(f, JSON.stringify({ ok: false, data: { tests: [] } })); return f; };
  const passing = { totals: { passed: 2, failed: 0 }, tests: [{ name: 'DEMO-101/TC-901: x', ticket: 'DEMO-101', caseId: 'TC-901', file: 'tests/ui.test.js', status: 'passed' }] };

  test('a heal that edits a shared helper re-runs the SAME selection as the main run (--spec), not the project default', async () => {
    const p = makeProject({ files: { 'tests/pages/cart.js': "exports.apply = (page) => page.getByTestId('coupon-apply-btn');\n", 'tests/ui.test.js': "const test = require('node:test');\ntest('DEMO-101/TC-901: x', () => {});\n" } });
    const seen = [];
    const r = await cli(['--report', reportFile(p), '--main', mainFile(p), '--framework', 'node', '--cwd', p.proj, '--paths', 'tests', '--apply', '--enable', '--run-id', 's1', '--spec', 'tests/ui.test.js', '--config', cfgFile(p.root, {})],
      async (argv) => { seen.push(argv); return { code: 0, doc: { ok: true, data: passing } }; });
    assert.equal(r.json.data.status, 'healed', JSON.stringify(r.json));
    assert.equal(r.json.data.validated.scope, 'selection');
    const specs = seen[0].flatMap((a, i) => (a === '--spec' ? [seen[0][i + 1]] : []));
    assert.deepEqual(specs, ['tests/ui.test.js'], 'it used to pass no --spec, so the whole default suite ran and an unrelated failure was blamed on the rename');
  });

  test('config trustedFormats is a floor: a report from a format the config does not trust is refused', async () => {
    const p = makeProject(); const before = p.state();
    const r = await cli(['--report', reportFile(p, { format: 'playwright-json' }), '--main', mainFile(p), '--framework', 'node', '--cwd', p.proj, '--paths', 'tests', '--apply', '--enable', '--config', cfgFile(p.root, { triage: { trustedFormats: ['tap'] } })], async () => ({ code: 0, doc: { ok: true, data: passing } }));
    assert.equal(r.json.data.status, 'refused', JSON.stringify(r.json));
    assert.match(r.json.data.reason, /playwright-json/);
    assert.deepEqual(p.state(), before);
  });

  test('config confidenceThreshold is a floor too: a TST-1 at 0.85 is not healed under a 0.9 threshold', async () => {
    const p = makeProject(); const before = p.state();
    const r = await cli(['--report', reportFile(p), '--main', mainFile(p), '--framework', 'node', '--cwd', p.proj, '--paths', 'tests', '--apply', '--enable', '--config', cfgFile(p.root, { triage: { confidenceThreshold: 0.9 } })], async () => ({ code: 0, doc: { ok: true, data: passing } }));
    assert.equal(r.json.data.status, 'refused', JSON.stringify(r.json));
    assert.match(r.json.data.reason, /0\.9/);
    assert.deepEqual(p.state(), before);
  });

  test('...and with the defaults it still heals (the floor is not a new obstacle)', async () => {
    const p = makeProject();
    const r = await cli(['--report', reportFile(p), '--main', mainFile(p), '--framework', 'node', '--cwd', p.proj, '--paths', 'tests', '--apply', '--enable', '--config', cfgFile(p.root, {})], async () => ({ code: 0, doc: { ok: true, data: passing } }));
    assert.equal(r.json.data.status, 'healed', JSON.stringify(r.json));
  });

  test('--max-files may tighten the configured cap but not lift it', async () => {
    const two = { 'tests/a.test.js': "getByTestId('coupon-apply-btn');\n", 'tests/b.test.js': "getByTestId('coupon-apply-btn');\n" };
    const p = makeProject({ files: { ...two, 'tests/ui.test.js': "const test = require('node:test');\ntest('DEMO-101/TC-901: x', () => {});\n" } });
    const before = p.state();
    const r = await cli(['--report', reportFile(p), '--main', mainFile(p), '--framework', 'node', '--cwd', p.proj, '--paths', 'tests', '--apply', '--enable', '--max-files', '5', '--config', cfgFile(p.root, { triage: { selfHeal: { maxFiles: 1 } } })], async () => ({ code: 0, doc: { ok: true, data: passing } }));
    assert.equal(r.json.data.status, 'refused', JSON.stringify(r.json));
    assert.match(r.json.data.reason, /more than the limit of 1/);
    assert.deepEqual(p.state(), before);
  });
});

// ── a real SIGTERM, a real runner ─────────────────────────────────────────────
describe('an interrupt also stops the validation run, not only the heal (review: the runner kept going and wrote into the project)', () => {
  test('SIGTERM to heal.js mid-validation: the repository is restored AND no test process outlives it', { timeout: 60000 }, async () => {
    const slow = `const test = require('node:test');
const fs = require('node:fs');
const { openPage } = require('./page');
test('DEMO-101/TC-901: the Apply button is on the cart panel', async () => {
  fs.writeFileSync(__dirname + '/../started', 'yes');
  openPage().getByTestId('coupon-apply');
  await new Promise((r) => setTimeout(r, 2500));
  fs.writeFileSync(__dirname + '/../LATE-WRITE', 'the runner outlived the heal');
});
`;
    const p = makeProject({ files: { 'tests/ui.test.js': slow.replace("getByTestId('coupon-apply')", "getByTestId('coupon-apply-btn')") } });
    const before = p.state();
    // the report names the stale id; the page has the new one: that is what makes the heal eligible
    const t = (status, extra = {}) => ({ name: 'DEMO-101/TC-901: the Apply button is on the cart panel', ticket: 'DEMO-101', caseId: 'TC-901', file: path.join(p.proj, 'tests', 'ui.test.js'), status, ...extra });
    const stale = { kind: 'failure', message: "locator not found: getByTestId('coupon-apply-btn')" };
    const report = classify({ runs: [1, 2, 3].map(() => ({ format: 'tap', tests: [t('failed', { error: stale })] })), evidence: { 'DEMO-101/TC-901': { locator: { target: 'coupon-apply-btn', present: false, candidates: [{ testid: 'coupon-apply', similarity: 0.8 }] } } } });
    fs.writeFileSync(path.join(p.root, 'triage.json'), JSON.stringify({ ok: true, data: report }));
    fs.writeFileSync(path.join(p.root, 'main.json'), JSON.stringify({ ok: false, data: { tests: [] } }));
    fs.writeFileSync(path.join(p.root, 'cfg.json'), '{}');

    const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'triage', 'heal.js'), '--report', path.join(p.root, 'triage.json'), '--main', path.join(p.root, 'main.json'), '--framework', 'node', '--cwd', p.proj, '--paths', 'tests', '--apply', '--enable', '--run-id', 'sig1', '--config', path.join(p.root, 'cfg.json')], { env: baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', (d) => { err += d; });
    const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    // wait until the heal is mid-validation: on its branch, with the runner's test already started
    for (let i = 0; i < 200 && !fs.existsSync(path.join(p.proj, 'started')); i += 1) await sleep(50);
    assert.ok(fs.existsSync(path.join(p.proj, 'started')), `the validation never started: ${err}`);
    child.kill('SIGTERM');
    const end = await exited;
    assert.equal(end.code, 143, `exit ${JSON.stringify(end)}: ${err}`);
    assert.match(err, /interrupted by SIGTERM; the repository was restored exactly as found/);
    fs.rmSync(path.join(p.proj, 'started'), { force: true });
    assert.deepEqual(p.state(), before);
    await sleep(4000); // longer than the test's own 2.5 s wait: if the runner survived, its late write has happened by now
    assert.equal(fs.existsSync(path.join(p.proj, 'LATE-WRITE')), false, 'the validation run kept going after the heal was interrupted');
  });
});

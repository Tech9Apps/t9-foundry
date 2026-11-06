'use strict';

// Findings from the second independent review of the triage PR. Each test below failed on the code it was written against;
// the comment on each says what the review found. The first group uses the EXACT shapes `node --test --test-reporter=tap`
// prints (captured from a real run), because TAP is the one format allowed to act: a hole here becomes a filed bug.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tap = require('../../scripts/results/lib/tap');
const { classify } = require('../../scripts/triage/classify');
const { fingerprint } = require('../../scripts/triage/fingerprint');
const { signatureOf } = require('../../scripts/triage/lib/text');
const { analyzeLocator } = require('../../scripts/triage/locators');
const { plan } = require('../../scripts/triage/plan');
const { orchestrate } = require('../../scripts/triage/orchestrate');

// ── real node:test TAP, as printed ─────────────────────────────────────────────
const filler = (n = 20) => Array.from({ length: n }, (_, i) => `ok ${i + 1} - DEMO-1/TC-9${i}: filler ${i}\n`).join('');
// `assert.equal(a, b)` failing: node prints "<a> !== <b>" and fills expected/actual
const assertFailure = (n, name, a, b) => `not ok ${n} - ${name}\n  ---\n  duration_ms: 0.25\n  type: 'test'\n  location: '/w/tests/n.test.js:${n}:1'\n  failureType: 'testCodeFailure'\n  error: |-\n    Expected values to be strictly equal:\n    \n    ${a} !== ${b}\n    \n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  expected: ${b}\n  actual: ${a}\n  operator: 'strictEqual'\n  stack: |-\n    TestContext.<anonymous> (/w/tests/n.test.js:${n}:10)\n  ...\n`;
// a thrown non-assertion error: node reports it with the same failureType, so only code/name tell them apart
const thrown = (n, name, message, errName = 'TypeError') => `not ok ${n} - ${name}\n  ---\n  duration_ms: 8.0\n  type: 'test'\n  location: '/w/tests/n.test.js:${n}:1'\n  failureType: 'testCodeFailure'\n  error: '${message}'\n  code: 'ERR_TEST_FAILURE'\n  name: '${errName}'\n  stack: |-\n    node:internal/deps/undici/undici:13510:13\n    async TestContext.<anonymous> (/w/tests/n.test.js:${n}:60)\n  ...\n`;

const triage = (...blocks) => {
  const src = filler() + blocks.join('');
  return classify({ runs: [tap.parse(src), tap.parse(src)] }); // main + one re-run, the default trusted format (tap)
};
const only = (rep) => { assert.equal(rep.verdicts.length, 1, 'exactly one failing test'); return rep.verdicts[0]; };

describe('node:test TAP: an outage is not a product bug (review HIGH-1)', () => {
  test('the TAP parser calls an error thrown in a test body an "error", and only a failed assertion a "failure"', () => {
    const t = tap.parse(thrown(1, 'x', 'fetch failed')).tests[0];
    assert.equal(t.error.kind, 'error');
    assert.equal(tap.parse(assertFailure(1, 'x', 1, 2)).tests[0].error.kind, 'failure');
  });

  for (const message of ['fetch failed', 'Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
    test(`"${message}" thrown from a test is an environment problem, never a filed bug`, () => {
      const v = only(triage(thrown(21, 'DEMO-1/TC-001: health', message)));
      assert.equal(v.class, 'environment');
      assert.equal(v.rule, 'ENV-2');
      assert.notEqual(v.class, 'product-bug');
    });
  }

  test('a TypeError that is NOT a network error is not a product bug either (it is not an assertion about the app)', () => {
    const v = only(triage(thrown(21, 'DEMO-1/TC-001: health', "Cannot read properties of undefined (reading \\'status\\')")));
    assert.notEqual(v.class, 'product-bug');
    assert.equal(v.action === 'act' && v.class === 'product-bug', false);
  });
});

describe('node:test TAP: an HTTP status in node\'s own wording is read (review HIGH-2)', () => {
  // node prints `assert.equal(res.status, 200)` failing as "503 !== 200": none of the Playwright-shaped patterns matched it
  const cases = [
    [502, 'environment'], [503, 'environment'], [504, 'environment'],
    [401, 'undetermined'], [403, 'undetermined'],
    [404, 'undetermined'], [500, 'undetermined'],
  ];
  for (const [status, klass] of cases) {
    test(`a status check that got ${status} is ${klass}, never a product bug`, () => {
      const v = only(triage(assertFailure(21, 'DEMO-1/TC-001: status', status, 200)));
      assert.equal(v.class, klass);
    });
  }

  test('...but an ordinary failed assertion is still a product bug, so the guard is not a blanket', () => {
    const v = only(triage(assertFailure(21, 'DEMO-1/TC-001: total', 10, 11)));
    assert.equal(v.class, 'product-bug');
    assert.equal(v.rule, 'PRD-1');
    assert.equal(v.action, 'act');
  });

  test('a number that merely contains 503 (1503 !== 200) is not mistaken for a gateway error', () => {
    const v = only(triage(assertFailure(21, 'DEMO-1/TC-001: total', 1503, 200)));
    assert.equal(v.class, 'product-bug');
  });
});

describe('fingerprints say what the assertion printed (review MEDIUM-5, MEDIUM-7)', () => {
  const failing = (a, b) => tap.parse(assertFailure(1, 'DEMO-1/TC-001: total', a, b)).tests[0];
  const fp = (t) => fingerprint(t).fingerprint;

  test('"10 !== 11" and "12 !== 11" are different defects', () => {
    assert.notEqual(fp(failing(10, 11)), fp(failing(12, 11)));
  });

  test('the same failure on two runs has the same fingerprint (the stack and timings do not leak in)', () => {
    assert.equal(fp(failing(10, 11)), fp(failing(10, 11)));
    assert.equal(fp(tap.parse(assertFailure(1, 'DEMO-1/TC-001: total', 10, 11).replace('0.25', '9.75')).tests[0]), fp(failing(10, 11)));
  });

  test('node\'s "a !== b" line counts even when the reporter gave no separate expected/actual fields', () => {
    const e = (a) => ({ kind: 'failure', message: 'Expected values to be strictly equal:', details: `Expected values to be strictly equal:\n\n${a} !== 11\n` });
    assert.notEqual(signatureOf(e(10)), signatureOf(e(12)));
    assert.equal(signatureOf(e(10)), signatureOf(e(10)));
  });

  test('a long message that CONTAINS the Expected/Received lines still keeps them', () => {
    const e = (received) => ({ kind: 'failure', message: `${'x'.repeat(400)}\nExpected: 5\nReceived: ${received}` });
    assert.notEqual(signatureOf(e(7)), signatureOf(e(8)));
  });

  test('five-digit values in Expected/Received are NOT masked: 12999 and 99999 (cents, ids) are different values', () => {
    const e = (received) => ({ kind: 'failure', message: 'price mismatch', details: `Expected: 12999\nReceived: ${received}` });
    assert.notEqual(signatureOf(e(13999)), signatureOf(e(99999)));
  });

  test('a long message does not push Expected/Received out of the signature', () => {
    const e = (received) => ({ kind: 'failure', message: 'x'.repeat(900), details: `Expected: 5\nReceived: ${received}` });
    assert.notEqual(signatureOf(e(7)), signatureOf(e(8)));
  });

  test('per-run identifiers do not change the fingerprint: request ids, short hex ids, trace ids', () => {
    const sig = (m) => signatureOf({ message: m });
    assert.equal(sig('request req_8f3a2b failed'), sig('request req_1c9d44 failed'));
    assert.equal(sig('session 8f3a2b4c expired'), sig('session 1c9d44ee expired'));
    assert.equal(sig('trace id: a1b2c3d4e5f6 not found'), sig('trace id: 0f9e8d7c6b5a not found'));
  });

  test('...while ordinary words that look a little like ids are left alone', () => {
    assert.notEqual(signatureOf({ message: 'cannot add item' }), signatureOf({ message: 'cannot remove item' }));
    assert.notEqual(signatureOf({ message: 'deadbeef is not a user' }), signatureOf({ message: 'feedface is not a user' }), 'letters-only words are not ids');
  });

  test('the same test at a different checkout path has the same fingerprint (and a moved file keeps it)', () => {
    const t = (file) => ({ name: 'login', file, error: { kind: 'failure', message: 'm' } });
    assert.equal(fp(t('/Users/a/work/app/tests/user/login.spec.js')), fp(t('/home/ci/build/tests/user/login.spec.js')));
    assert.equal(fp(t('/repo/tests/user/login.spec.js')), fp(t('/repo/tests/people/login.spec.js')));
  });
});

// ── identity of a test across runs (review HIGH-3, MEDIUM-6, MEDIUM-8) ─────────
const P = (extra) => ({ status: 'passed', ...extra });
const F = (extra) => ({ status: 'failed', error: { kind: 'failure', message: 'expected 5 but got 6' }, ...extra });
const runOf = (tests, format = 'playwright-json') => ({ format, tests });
const TRUST = { trustedFormats: ['playwright-json', 'tap'] };
const ids = { ticket: 'DEMO-101', caseId: 'TC-005' };
const chromium = (make) => make({ ...ids, name: 'DEMO-101/TC-005: checkout total [chromium]' });
const webkit = (make) => make({ ...ids, name: 'DEMO-101/TC-005: checkout total [webkit]' });

describe('one test per project/file: a failure is never dropped or called flaky (review HIGH-3)', () => {
  const three = (list) => classify({ runs: [runOf(list), runOf(list), runOf(list)], ...TRUST });

  test('chromium passes and webkit fails every time: the webkit failure is reported (listed after chromium)', () => {
    const rep = three([chromium(P), webkit(F)]);
    assert.equal(rep.verdicts.length, 1, 'the failure must not vanish');
    assert.match(rep.verdicts[0].test.name, /webkit/);
    assert.equal(rep.verdicts[0].class, 'product-bug');
  });

  test('...and it is not called flaky when webkit is listed first', () => {
    const rep = three([webkit(F), chromium(P)]);
    assert.equal(rep.verdicts.length, 1);
    assert.match(rep.verdicts[0].test.name, /webkit/);
    assert.notEqual(rep.verdicts[0].class, 'flaky');
  });

  test('both projects fail: two verdicts, one per project', () => {
    const rep = three([chromium(F), webkit(F)]);
    assert.deepEqual(rep.verdicts.map((v) => v.test.name).sort(), ['DEMO-101/TC-005: checkout total [chromium]', 'DEMO-101/TC-005: checkout total [webkit]']);
  });

  test('two files that reuse one case id are two tests', () => {
    const a = F({ ...ids, name: 'checkout total', file: '/w/tests/a/checkout.spec.js' });
    const b = P({ ...ids, name: 'checkout total', file: '/w/tests/b/checkout.spec.js' });
    const rep = three([a, b]);
    assert.equal(rep.verdicts.length, 1);
    assert.match(rep.verdicts[0].test.file, /a\/checkout/);
    assert.equal(rep.verdicts[0].class, 'product-bug');
  });

  test('a test that fails in one project and passes on re-run is still flaky, per project', () => {
    const main = runOf([webkit(F), chromium(P)]);
    const rerun = runOf([webkit(P)]); // a re-run of the failing file only
    const rep = classify({ runs: [main, rerun], ...TRUST });
    assert.equal(rep.verdicts.length, 1);
    assert.equal(rep.verdicts[0].class, 'flaky');
  });

  test('same-named files in different folders, same title, same error: two verdicts (neither is dropped), one shared fingerprint', () => {
    const t = (file) => F({ name: 'login', file });
    const rep = classify({ runs: [runOf([t('/w/tests/admin/login.spec.js'), t('/w/tests/user/login.spec.js')])], ...TRUST });
    assert.equal(rep.verdicts.length, 2);
    assert.notEqual(rep.verdicts[0].key, rep.verdicts[1].key);
  });

  test('a reworded title is still ONE test across runs: the ticket/case identity is what matches them', () => {
    const a = (name) => F({ ...ids, name });
    const rep = classify({ runs: [runOf([a('DEMO-101/TC-005: old wording')]), runOf([P({ ...ids, name: 'DEMO-101/TC-005: new wording' })])], ...TRUST });
    assert.equal(rep.verdicts.length, 1);
    assert.equal(rep.verdicts[0].class, 'flaky');
  });

  test('a test whose identity is unique keeps the plain key (ticket/case) the rest of the pipeline and the docs use', () => {
    const rep = classify({ runs: [runOf([F({ ...ids, name: 'DEMO-101/TC-005: x' })]), runOf([F({ ...ids, name: 'DEMO-101/TC-005: x' })])], ...TRUST });
    assert.equal(rep.verdicts[0].key, 'DEMO-101/TC-005');
  });
});

describe('a test without a ticket keeps its identity when a later attempt has no file (review MEDIUM-6)', () => {
  // node's TAP carries `location` (so a file) only for FAILING tests; the same test passing on the re-run has none
  test('login works: fails, then passes on re-run → flaky, not a product-bug proposal', () => {
    const rep = classify({ runs: [runOf([F({ name: 'login works', file: '/w/tests/a.test.js' })], 'tap'), runOf([P({ name: 'login works' })], 'tap')] });
    assert.equal(rep.verdicts.length, 1);
    assert.equal(rep.verdicts[0].class, 'flaky');
    assert.equal(rep.verdicts[0].rule, 'FLK-1');
  });

  test('the same holds for a case id with no ticket', () => {
    const rep = classify({ runs: [runOf([F({ caseId: 'TC-777', name: 'TC-777: x', file: '/w/tests/a.test.js' })], 'tap'), runOf([P({ caseId: 'TC-777', name: 'TC-777: x' })], 'tap')] });
    assert.equal(rep.verdicts[0].class, 'flaky');
  });

  test('...and a title shared by two files is NOT merged by guessing a file for the attempt that has none (either order)', () => {
    for (const order of [['a', 'b'], ['b', 'a']]) {
      const f = (x) => (x === 'a' ? F : P)({ name: 'login', file: `/w/tests/${x}.test.js` });
      const rep = classify({ runs: [runOf(order.map(f), 'tap'), runOf([P({ name: 'login' })], 'tap')] });
      assert.equal(rep.verdicts.length, 1);
      assert.equal(rep.verdicts[0].class !== 'flaky', true, 'an attempt with no file cannot be attributed to either file');
      assert.deepEqual(rep.verdicts[0].attempts.map((a) => a.run), [0], `only the main run belongs to a.test.js (order ${order})`);
    }
  });
});

describe('the same defect seen twice in one run is reported once (review MEDIUM-8)', () => {
  test('the same test failing the same way in two projects yields one file-bug and one duplicate-in-run, with no hand-forced fingerprint', async () => {
    const list = [chromium(F), webkit(F)];
    const report = classify({ runs: [runOf(list), runOf(list), runOf(list)], ...TRUST });
    assert.notEqual(report.verdicts[0].fingerprint, undefined);
    assert.equal(report.verdicts[0].fingerprint, report.verdicts[1].fingerprint, 'same test + same error = same defect');
    const p = await plan({ report, runId: 'r1', adapter: null });
    assert.deepEqual(p.actions.map((a) => a.step), ['file-bug', 'duplicate-in-run']);
  });
});

// ── orchestrate ───────────────────────────────────────────────────────────────
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-r2-'));
const passed = { format: 'tap', totals: { total: 2, passed: 2, failed: 0, skipped: 0 }, tests: [P({ name: 'a' }), P({ name: 'b' })] };

describe('orchestrate: a run whose exit code contradicts its report is not a pass (review MEDIUM, exit 3)', () => {
  test('the results runner exits 3 but still hands back a report: orchestrate stops with exit 3 and says why', async () => {
    const runResults = async () => ({ code: 3, doc: { ok: false, exitCode: 2, data: passed, warnings: ['the runner exited 2 but its report shows no failures — it may have crashed after writing a partial report'] } });
    const r = await orchestrate({ specs: [], reruns: 2, out: tmp(), framework: 'node' }, { env: {}, runResults });
    assert.equal(r.code, 3);
    assert.equal(r.doc.ok, false);
    assert.equal(r.doc.stage, 'run');
    assert.match(JSON.stringify(r.doc), /exited 2 but its report shows no failures/);
    assert.notEqual(r.doc.data && r.doc.data.status, 'green');
  });
});

describe('orchestrate: old re-run directories are not mixed into a new run (review LOW)', () => {
  test('rerun-<k> directories left by an earlier run are cleared; other folders are left alone', async () => {
    const out = tmp();
    for (const d of ['rerun-1', 'rerun-2', 'rerun-backup', 'main-old']) { fs.mkdirSync(path.join(out, d), { recursive: true }); fs.writeFileSync(path.join(out, d, 'result.json'), '{}'); }
    const runResults = async () => ({ code: 0, doc: { ok: true, data: passed } });
    await orchestrate({ specs: [], reruns: 0, out, framework: 'node' }, { env: {}, runResults });
    assert.equal(fs.existsSync(path.join(out, 'rerun-1')), false);
    assert.equal(fs.existsSync(path.join(out, 'rerun-2')), false);
    assert.equal(fs.existsSync(path.join(out, 'rerun-backup')), true, 'only rerun-<number> is ours');
    assert.equal(fs.existsSync(path.join(out, 'main-old')), true);
  });
});

describe('locators: a removed feature is not mistaken for a rename (review LOW)', () => {
  const html = (id) => `<button data-testid="${id}">x</button>`;
  test('cart-count with only cart-total on the page: one shared word is not a rename candidate', () => {
    assert.deepEqual(analyzeLocator({ html: html('cart-total'), selector: "getByTestId('cart-count')" }).candidates, []);
  });
  for (const [from, to] of [['submit-btn', 'submit-button'], ['add-to-cart', 'add-to-basket'], ['email', 'email-input'], ['checkout-button', 'checkout-btn-primary']]) {
    test(`a real rename still matches: ${from} → ${to}`, () => {
      assert.equal(analyzeLocator({ html: html(to), selector: `getByTestId('${from}')` }).candidates.length, 1);
    });
  }
});

// ── which decision is the later one (review MEDIUM-9) ──────────────────────────
describe('plan: a report closed without a fix beats an OLDER fixed one, never a newer one', () => {
  const verdictFor = () => classify({ runs: [runOf([F({ ...ids, name: 'DEMO-101/TC-005: x' })], 'tap'), runOf([F({ ...ids, name: 'DEMO-101/TC-005: x' })], 'tap'), runOf([F({ ...ids, name: 'DEMO-101/TC-005: x' })], 'tap')] });
  // an adapter with exactly the two operations plan() uses; every hit carries the token, as the plan insists
  const adapterWith = (items) => ({
    search: async () => ({ items }),
    fetchTicket: async (id) => ({ id, description: `qa-harness-fingerprint: ${verdictFor().verdicts[0].token}` }),
  });
  const fixed = (id, createdAt) => ({ id, title: 't', url: `u/${id}`, status: 'closed', open: false, ...(createdAt ? { createdAt } : {}) });
  const wont = (id, createdAt) => ({ id, title: 't', url: `u/${id}`, status: 'wontfix', open: false, dismissed: true, ...(createdAt ? { createdAt } : {}) });
  const stepFor = async (items) => (await plan({ report: verdictFor(), runId: 'r1', adapter: adapterWith(items) })).actions[0];

  test('fixed, then (later) dismissed: report-dismissed — the team already decided about the recurrence', async () => {
    const a = await stepFor([fixed('1', '2026-01-01T00:00:00Z'), wont('2', '2026-02-01T00:00:00Z')]);
    assert.equal(a.step, 'report-dismissed');
    assert.equal(a.dismissedAs.id, '2');
  });

  test('dismissed, then (later) fixed: it came back after a real fix, so it is a regression', async () => {
    const a = await stepFor([wont('1', '2026-01-01T00:00:00Z'), fixed('2', '2026-02-01T00:00:00Z')]);
    assert.equal(a.step, 'file-regression');
    assert.equal(a.regressionOf.id, '2');
  });

  test('no dates on either side: the order is unknown, so it stays a regression and says a person should check', async () => {
    const a = await stepFor([fixed('1'), wont('2')]);
    assert.equal(a.step, 'file-regression');
    assert.match(a.note, /if it is the later decision, do not file/);
  });

  test('a date on only one side is not enough to order them', async () => {
    const a = await stepFor([fixed('1', '2026-01-01T00:00:00Z'), wont('2')]);
    assert.equal(a.step, 'file-regression');
  });

  test('only a dismissed report matches: report-dismissed, whatever the dates', async () => {
    assert.equal((await stepFor([wont('1')])).step, 'report-dismissed');
  });

  test('only a fixed report matches: file-regression, with no "check the dismissed one" note', async () => {
    const a = await stepFor([fixed('1', '2026-01-01T00:00:00Z')]);
    assert.equal(a.step, 'file-regression');
    assert.doesNotMatch(a.note, /do not file/);
  });
});

// ── a directory of reports in different formats (review: mixed formats) ────────
describe('normalize: a directory that mixes report formats is refused, not labelled with the first one', () => {
  const { normalizePath } = require('../../scripts/results/normalize');
  const put = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text);
  const TAP = 'TAP version 13\nok 1 - a\n1..1\n';
  const JUNIT = '<testsuites><testsuite name="s" tests="1"><testcase name="b" classname="c"/></testsuite></testsuites>';

  test('a tap file and a junit file in one directory: MIXED_FORMATS', () => {
    const d = tmp(); put(d, 'a.tap', TAP); put(d, 'b.xml', JUNIT);
    assert.throws(() => normalizePath(d), (e) => e.code === 'MIXED_FORMATS' && /tap, junit|junit, tap/.test(e.message));
  });

  test('several files of ONE format still merge', () => {
    const d = tmp(); put(d, 'a.tap', TAP); put(d, 'b.tap', TAP.replace('- a', '- b'));
    const r = normalizePath(d);
    assert.equal(r.format, 'tap');
    assert.equal(r.totals.total, 2);
  });
});

describe('orchestrate: locator evidence follows the test, not just its title', () => {
  test('two tests with the same title in different files each get THEIR OWN evidence', async () => {
    const out = tmp();
    const snapshot = path.join(out, 'page.html');
    fs.writeFileSync(snapshot, '<button data-testid="submit-button">Go</button><button data-testid="cancel-button">No</button>');
    const locatorFail = (id) => ({ kind: 'failure', message: 'locator.click: Timeout 30000ms exceeded', details: `waiting for getByTestId('${id}')` });
    const t = (file, id) => ({ name: 'login', status: 'failed', file, error: locatorFail(id) });
    const main = { format: 'tap', totals: { total: 2, passed: 0, failed: 2, skipped: 0 }, tests: [t('/w/tests/a.test.js', 'submit-btn'), t('/w/tests/b.test.js', 'cancel-btn')] };
    const runResults = async () => ({ code: 1, doc: { ok: false, data: main } });
    const r = await orchestrate({ specs: [], reruns: 1, out, framework: 'node', snapshot, noPlan: true }, { env: {}, runResults });
    const rep = JSON.parse(fs.readFileSync(path.join(out, 'triage.json'), 'utf8')).data;
    assert.equal(rep.verdicts.length, 2);
    const byFile = Object.fromEntries(rep.verdicts.map((v) => [path.basename(v.test.file), v.evidence.join(' ')]));
    assert.match(byFile['a.test.js'], /"submit-btn".*"submit-button"/);
    assert.match(byFile['b.test.js'], /"cancel-btn".*"cancel-button"/);
    assert.equal(r.code, 0);
  });
});

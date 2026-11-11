'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzeLocator, similarity, main } = require('../../scripts/triage/locators');

const PAGE = `<main>
  <button data-testid="add-to-basket" class="b">Add to basket</button>
  <button data-testid="checkout-button">Checkout</button>
  <span data-testid='cart-count'>0</span>
  <a data-cy="home-link" href="/">Home</a>
</main>`;

describe('similarity', () => {
  test('shared tokens, abbreviations and prefixes count; unrelated ids do not', () => {
    assert.equal(similarity('add-to-cart', 'add-to-basket'), 0.67);
    assert.equal(similarity('checkout-btn', 'checkout-button'), 1); // btn = button
    assert.equal(similarity('qty-input', 'quantity-input'), 1);
    assert.equal(similarity('addToCart', 'add-to-cart'), 1); // camelCase splits
    assert.ok(similarity('login-button', 'cart-count') < 0.5);
    assert.equal(similarity('', 'x'), 0);
  });
  test('cart and basket are NOT assumed to be synonyms (a page can have both)', () => {
    assert.ok(similarity('cart', 'basket') < 0.5);
  });
});

describe('analyzeLocator', () => {
  test('a renamed test-id: not present, exactly one resembling element, with its tag and text', () => {
    const r = analyzeLocator({ html: PAGE, selector: "waiting for getByTestId('add-to-cart')" });
    assert.equal(r.target, 'add-to-cart');
    assert.equal(r.present, false);
    assert.deepEqual(r.candidates, [{ testid: 'add-to-basket', tag: 'button', text: 'Add to basket', similarity: 0.67 }]);
  });
  test('an id that IS on the page is reported present (so it is not a stale selector)', () => {
    const r = analyzeLocator({ html: PAGE, selector: '[data-testid=checkout-button]' });
    assert.equal(r.present, true);
    assert.deepEqual(r.candidates, []);
  });
  test('nothing resembles it → no candidates; single-quoted and data-cy attributes are read', () => {
    assert.deepEqual(analyzeLocator({ html: PAGE, selector: 'getByTestId("payment-form")' }).candidates, []);
    assert.equal(analyzeLocator({ html: PAGE, selector: '[data-testid=cart-count]' }).present, true);
    assert.equal(analyzeLocator({ html: PAGE, selector: '[data-cy=home-link]' }).present, true);
  });
  test('candidates are ordered best first', () => {
    const html = '<i data-testid="add-to-bag">x</i><b data-testid="add-to-basket-now">y</b>';
    const r = analyzeLocator({ html, selector: 'getByTestId("add-to-basket")' });
    assert.deepEqual(r.candidates.map((c) => c.testid), ['add-to-basket-now', 'add-to-bag']);
  });
  test('a selector with no test-id in it is an error that says what was looked for', () => {
    assert.throws(() => analyzeLocator({ html: PAGE, selector: '.some > a' }), { code: 'NO_TESTID' });
  });
  test('a bare id is accepted as the selector', () => {
    assert.equal(analyzeLocator({ html: PAGE, selector: 'add-to-cart' }).target, 'add-to-cart');
  });
});

describe('locators CLI', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-loc-'));
  const html = path.join(dir, 'page.html');
  fs.writeFileSync(html, PAGE);
  const cli = (argv) => { let out = ''; let e = ''; const code = main({ argv, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { e += s; } } }); return { code, err: e, json: out ? JSON.parse(out) : null }; };

  test('prints the exact object classify.js reads as `locator` evidence', () => {
    const r = cli(['--html', html, '--selector', "getByTestId('add-to-cart')"]);
    assert.equal(r.code, 0);
    assert.deepEqual(Object.keys(r.json.data), ['target', 'present', 'candidates']);
  });
  test('errors: unreadable file / no test-id → exit 1; bad invocation → exit 2', () => {
    assert.equal(cli(['--html', path.join(dir, 'x.html'), '--selector', 'a-b']).json.error.code, 'UNREADABLE');
    assert.equal(cli(['--html', html, '--selector', '.x > y']).json.error.code, 'NO_TESTID');
    for (const argv of [[], ['--html', html], ['--selector', 'x'], ['--bogus'], ['--html']]) assert.equal(cli(argv).code, 2, argv.join(' '));
  });
});

describe('locators CLI: by fingerprint token (the form an agent uses, so no failure text reaches a command line)', () => {
  const { classify } = require('../../scripts/triage/classify');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-loc-tok-'));
  const html = path.join(dir, 'page.html');
  fs.writeFileSync(html, PAGE);
  const TOKEN = 'qafp0123456789ab';
  // as Playwright reports it: the summary is one line, the test-id is only in the details
  const verdict = (over = {}) => ({ key: "ui.spec.ts|user can't add it", token: TOKEN, error: { kind: 'failure', message: 'expect(locator).toBeVisible()', details: "Locator: getByTestId('add-to-cart')\nExpected: visible\nReceived: <element(s) not found>\nCall log:\n  - waiting for getByTestId('add-to-cart')" }, ...over });
  const reportFile = (verdicts, name = 'triage.json') => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify({ ok: true, data: { verdicts } })); return f; };
  const cli = (argv) => { let out = ''; let e = ''; const code = main({ argv, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { e += s; } } }); return { code, err: e, json: out ? JSON.parse(out) : null }; };

  test('finds the verdict by token, reads the test-id from its DETAILS, and files the result under the verdict\'s key', () => {
    const rep = reportFile([verdict()]); const ev = path.join(dir, 'ev1.json');
    const r = cli(['--html', html, '--report', rep, '--token', TOKEN, '--evidence-out', ev]);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.equal(r.json.data.target, 'add-to-cart');
    assert.equal(r.json.key, "ui.spec.ts|user can't add it");
    assert.deepEqual(JSON.parse(fs.readFileSync(ev, 'utf8')), { "ui.spec.ts|user can't add it": { locator: r.json.data } });
  });

  test('without --evidence-out it only prints', () => {
    const r = cli(['--html', html, '--report', reportFile([verdict()]), '--token', TOKEN]);
    assert.equal(r.code, 0);
    assert.equal(r.json.evidenceFile, undefined);
  });

  test('it MERGES: other tests\' evidence and other fields of the same test survive', () => {
    const ev = path.join(dir, 'ev2.json');
    fs.writeFileSync(ev, JSON.stringify({ other: { locator: { target: 'x', present: true, candidates: [] } }, "ui.spec.ts|user can't add it": { note: 'keep me' } }));
    assert.equal(cli(['--html', html, '--report', reportFile([verdict()]), '--token', TOKEN, '--evidence-out', ev]).code, 0);
    const merged = JSON.parse(fs.readFileSync(ev, 'utf8'));
    assert.equal(merged.other.locator.target, 'x');
    assert.equal(merged["ui.spec.ts|user can't add it"].note, 'keep me');
    assert.equal(merged["ui.spec.ts|user can't add it"].locator.target, 'add-to-cart');
  });

  test('an evidence file that cannot be read is left exactly as it was (never overwritten)', () => {
    const ev = path.join(dir, 'ev3.json'); fs.writeFileSync(ev, '{ not json');
    const r = cli(['--html', html, '--report', reportFile([verdict()]), '--token', TOKEN, '--evidence-out', ev]);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, 'UNREADABLE');
    assert.equal(fs.readFileSync(ev, 'utf8'), '{ not json');
    fs.writeFileSync(ev, '[1,2]');
    assert.equal(cli(['--html', html, '--report', reportFile([verdict()]), '--token', TOKEN, '--evidence-out', ev]).code, 1);
    assert.equal(fs.readFileSync(ev, 'utf8'), '[1,2]');
  });

  test('errors: unknown token, a verdict with no error text, an unreadable report → exit 1 with a code', () => {
    assert.equal(cli(['--html', html, '--report', reportFile([verdict()]), '--token', 'qafpffffffffffff']).json.error.code, 'UNKNOWN_TOKEN');
    assert.equal(cli(['--html', html, '--report', reportFile([verdict({ error: undefined })]), '--token', TOKEN]).json.error.code, 'NO_ERROR');
    assert.equal(cli(['--html', html, '--report', path.join(dir, 'missing.json'), '--token', TOKEN]).json.error.code, 'UNREADABLE');
    assert.equal(cli(['--html', html, '--report', reportFile([verdict({ error: { kind: 'failure', message: 'boom' } })]), '--token', TOKEN]).json.error.code, 'NO_TESTID');
  });

  test('usage errors → exit 2: a token that is not a fingerprint token (nothing else is ever accepted), mixed modes, a lone flag', () => {
    const rep = reportFile([verdict()]);
    for (const bad of ['$(touch pwned)', 'qafp123', "qafp0123456789ab'; rm -rf /", '../../etc/passwd', 'QAFP0123456789AB']) assert.equal(cli(['--html', html, '--report', rep, '--token', bad]).code, 2, bad);
    assert.equal(cli(['--html', html, '--report', rep, '--token', TOKEN, '--selector', 'x']).code, 2, 'both modes');
    assert.equal(cli(['--html', html, '--report', rep]).code, 2, '--report alone');
    assert.equal(cli(['--html', html, '--token', TOKEN]).code, 2, '--token alone');
    assert.equal(cli(['--html', html, '--selector', 'add-to-cart', '--evidence-out', path.join(dir, 'e.json')]).code, 2, '--evidence-out needs a verdict key');
  });

  test('round trip: the file this writes is exactly what classify.js reads as --evidence (stale selector → TST-1)', () => {
    const ev = path.join(dir, 'ev4.json');
    const run = () => ({ format: 'tap', totals: {}, tests: [{ name: 'DEMO-101/TC-005: add', status: 'failed', ticket: 'DEMO-101', caseId: 'TC-005', file: 'ui.spec.ts',
      error: { kind: 'failure', message: 'expect(locator).toBeVisible()', details: "Locator: getByTestId('add-to-cart')\nReceived: <element(s) not found>\nCall log:\n  - waiting for getByTestId('add-to-cart')" } }] });
    const first = classify({ runs: [run(), run(), run()] });
    assert.deepEqual([first.verdicts[0].class, first.verdicts[0].rule], ['undetermined', 'UND-1'], 'without evidence it is only a proposal');
    assert.match(first.verdicts[0].error.details, /getByTestId\('add-to-cart'\)/, 'the report keeps the diagnosis, which is how the token form finds the test-id');
    const rep = path.join(dir, 'triage-rt.json'); fs.writeFileSync(rep, JSON.stringify({ ok: true, data: first }));
    assert.equal(cli(['--html', html, '--report', rep, '--token', first.verdicts[0].token, '--evidence-out', ev]).code, 0);
    const second = classify({ runs: [run(), run(), run()], evidence: JSON.parse(fs.readFileSync(ev, 'utf8')) });
    assert.deepEqual([second.verdicts[0].class, second.verdicts[0].rule, second.verdicts[0].action], ['test-bug', 'TST-1', 'act']);
  });
});

describe('analyzeLocator reads the page like a parser, not a regex: "not on the page" must never be said of an element that is', () => {
  // A wrong "present: false" next to a similar id is a TST-1 verdict (test-bug 0.85, act). The third review found these shapes read as absent.
  const sel = "getByTestId('add-to-cart')";
  const at = (html, selector = sel) => analyzeLocator({ html, selector });
  const present = (html, selector) => at(html, selector).present;

  test('an unquoted attribute value', () => {
    assert.equal(present('<button data-testid=add-to-cart>Add</button><button data-testid="add-to-cart-all">All</button>'), true);
    assert.equal(present('<button class=b data-testid=add-to-cart class=c>Add</button>'), true);
  });
  test('a ">" inside an EARLIER quoted attribute value', () => {
    assert.equal(present('<button title="a>b" data-testid="add-to-cart">Add</button>'), true);
    assert.equal(present("<button title='x > y' data-testid='add-to-cart'>Add</button>"), true);
  });
  test('attribute names in any case', () => {
    assert.equal(present('<BUTTON DATA-TESTID="add-to-cart">Add</BUTTON>'), true);
    assert.equal(present('<button Data-TestId="add-to-cart">Add</button>'), true);
  });
  test('data-test is read, because extractTestId accepts it from the error ([data-test="x"])', () => {
    assert.equal(present('<i data-test="x"></i>', '[data-test="x"]'), true);
    assert.equal(present('<i data-test-id="x"></i>', '[data-test-id="x"]'), true);
  });
  test('whitespace around "=", newlines between attributes, self-closing tags', () => {
    assert.equal(present('<input\n  type="text"\n  data-testid = "add-to-cart"\n/>'), true);
    assert.equal(at('<input data-testid="add-to-cart"/>').candidates.length, 0);
  });
  test('a comment, a script and a style are not the page', () => {
    assert.equal(present('<!-- <button data-testid="add-to-cart">old</button> -->'), false);
    assert.equal(present('<script>const html = \'<button data-testid="add-to-cart">\'</script>'), false);
    assert.equal(present('<style>/* <b data-testid="add-to-cart"> */</style><p>x</p>'), false);
    assert.equal(present('<!-- <b data-testid="add-to-cart"> --><i data-testid="add-to-cart"></i>'), true, 'but the real one after the comment is');
  });
  test('what it already did still works: candidates, text and tag, exact match only', () => {
    const r = at('<main><button data-testid="add-to-basket">  Add   to basket </button><a data-cy="add-to-cart-all">x</a></main>');
    assert.equal(r.present, false);
    assert.deepEqual(r.candidates.map((c) => [c.testid, c.tag, c.text]), [['add-to-cart-all', 'a', 'x'], ['add-to-basket', 'button', 'Add to basket']]);
  });
  test('a REPEATED attribute: the first one counts, as in a browser', () => {
    assert.equal(present('<i data-testid="add-to-cart" data-testid="other"></i>'), true);
    assert.equal(present('<i data-testid="other" data-testid="add-to-cart"></i>'), false);
    assert.equal(present('<i DATA-TESTID="other" data-testid="add-to-cart"></i>'), false, 'the same attribute in another case is the same attribute');
  });
  test('DIFFERENT test attributes on one element are all exposed: data-cy="x" data-testid="add-to-cart" has both ids', () => {
    assert.equal(present('<button data-cy="x" data-testid="add-to-cart">Add</button>'), true);
    assert.equal(present('<button data-testid="x" data-cy="add-to-cart">Add</button>'), true);
    assert.equal(present('<button data-qa="x" data-test="y" data-test-id="add-to-cart">Add</button>'), true);
    assert.equal(present('<button data-cy="x" data-testid="y">Add</button>'), false);
  });
  test('empty and odd comments end where HTML says they end: <!-->, <!--->, --!>', () => {
    for (const open of ['<!-->', '<!--->']) assert.equal(present(`${open}<button data-testid="add-to-cart">Add</button>`), true, open);
    assert.equal(present('<!-- x --!><button data-testid="add-to-cart">Add</button>'), true);
    assert.equal(present('<!-- x --><button data-testid="add-to-cart">Add</button>'), true);
    assert.equal(present('<!-- <button data-testid="add-to-cart"> -->'), false);
    assert.equal(present('<!-- never closed <button data-testid="add-to-cart">'), false, 'an unterminated comment swallows the rest, as in a browser');
  });
  test('a page too large to scan is an ERROR, never "the element is not on the page"', () => {
    const big = `${'<p>x</p>'.repeat(9 * 1024 * 1024 + 10)}<i data-testid="add-to-cart"></i>`; // > 64 MB, the id is at the very end
    assert.throws(() => at(big), (e) => e.code === 'TOO_LARGE' && /too large/.test(e.message));
  });
  test('malformed HTML does not throw and does not hang', () => {
    for (const html of ['<', '<a', '<a data-testid="x', '<a data-testid=', '<<<>>>', '</>', '<!--', '<a "x" data-testid="add-to-cart">']) assert.doesNotThrow(() => at(html), html);
  });
  test('the scan is linear: a page of unterminated tags does not take seconds', () => {
    const t = Date.now();
    at('<a '.repeat(60000));
    at(`<div ${'x '.repeat(60000)}`);
    assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
  });
});

describe('analyzeLocator: a page with thousands of script tags is still one linear pass', () => {
  test('60000 <script> blocks', () => {
    const html = `${'<script>var a = 1</script>'.repeat(60000)}<i data-testid="add-to-cart"></i>`;
    const t = Date.now();
    assert.equal(analyzeLocator({ html, selector: "getByTestId('add-to-cart')" }).present, true);
    assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
  });
});

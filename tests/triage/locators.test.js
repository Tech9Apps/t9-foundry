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

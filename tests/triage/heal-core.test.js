'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isSafeTestId, replaceInLocators, leftovers, verifyOnlySubstitution, collectFiles, MAX_BYTES } = require('../../scripts/triage/lib/heal-core');

const FROM = 'add-to-cart';
const TO = 'add-to-basket';
const rename = (src) => replaceInLocators(src, FROM, TO);

describe('isSafeTestId: the new id comes from untrusted page HTML', () => {
  test('ordinary ids are accepted', () => {
    for (const ok of ['add-to-basket', 'addToBasket', 'cart_1', 'a.b', 'ns:item-2', 'X']) assert.ok(isSafeTestId(ok), ok);
  });
  test('anything that could break out of a string, selector or statement is refused', () => {
    for (const bad of ["x');process.exit(1);//", 'x"]', 'a b', 'a/b', 'a\\b', 'a`b', '$(rm -rf)', 'a;b', 'a)b', 'a\nb', '', 'x'.repeat(121), null, undefined, 42, '<script>']) assert.equal(isSafeTestId(bad), false, JSON.stringify(bad));
  });
});

describe('replaceInLocators: only the id inside a locator expression', () => {
  const forms = [
    ['getByTestId double quotes', `await page.getByTestId("${FROM}").click();`],
    ['getByTestId single quotes', `page.getByTestId('${FROM}')`],
    ['getByTestId backticks', 'page.getByTestId(`add-to-cart`)'],
    ['getByTestId with spaces', `page.getByTestId(  '${FROM}'  )`],
    ['getAllByTestId', `screen.getAllByTestId('${FROM}')`],
    ['queryByTestId', `screen.queryByTestId('${FROM}')`],
    ['findByTestId', `await screen.findByTestId('${FROM}')`],
    ['get_by_test_id (python)', `page.get_by_test_id("${FROM}")`],
    ['css attribute, double quotes', `page.locator('[data-testid="${FROM}"]')`],
    ['css attribute, single quotes', `cy.get("[data-testid='${FROM}']")`],
    ['css attribute, unquoted', `cy.get('[data-testid=${FROM}]')`],
    ['css attribute, escaped quotes in a string', `page.locator("[data-testid=\\"${FROM}\\"]")`],
    ['data-cy', `cy.get('[data-cy=${FROM}]')`],
    ['data-test-id', `find('[data-test-id="${FROM}"]')`],
    ['data-qa', `$('[data-qa=${FROM}]')`],
    ['attribute with spaces', `page.locator('[ data-testid = "${FROM}" ]')`],
  ];
  for (const [name, line] of forms) {
    test(`renames ${name}`, () => {
      const r = rename(line);
      assert.equal(r.changes.length, 1);
      assert.equal(r.text, line.split(FROM).join(TO));
      assert.deepEqual(verifyOnlySubstitution(line, r.text, FROM, TO), { ok: true });
    });
  }

  test('a DIFFERENT id that merely starts with the old one is not touched', () => {
    for (const line of [`page.getByTestId('${FROM}-2')`, `page.locator('[data-testid="${FROM}-2"]')`, `page.getByTestId('x-${FROM}')`, `page.locator('[data-testid=pre-${FROM}]')`]) assert.equal(rename(line).changes.length, 0, line);
  });

  test('a bare string, a constant, a comment and a test title are NOT edited, and are reported as left over', () => {
    const src = [`const NAME = "${FROM}";`, `// click ${FROM}`, `test('${FROM} works', () => {});`, `await page.getByTestId('${FROM}').click();`].join('\n');
    const r = rename(src);
    assert.deepEqual(r.changes.map((c) => c.line), [4]);
    assert.deepEqual(leftovers(r.text, FROM).map((l) => l.line), [1, 2, 3]);
  });

  test('assertions and expected values on the same line are untouched: only the id moves', () => {
    const line = `await expect(page.getByTestId('${FROM}')).toHaveText('Add to cart');`;
    const r = rename(line);
    assert.equal(r.text, `await expect(page.getByTestId('${TO}')).toHaveText('Add to cart');`);
  });

  test('an id equal to part of the syntax ("testid") cannot damage the attribute name', () => {
    const line = `page.locator('[data-testid="testid"]'); page.getByTestId('testid');`;
    const r = replaceInLocators(line, 'testid', 'checkout-btn');
    assert.equal(r.text, `page.locator('[data-testid="checkout-btn"]'); page.getByTestId('checkout-btn');`);
  });

  test('regex metacharacters in an id are matched literally, not as a pattern', () => {
    assert.equal(replaceInLocators(`page.getByTestId('a.b')`, 'a.b', 'c').changes.length, 1);
    assert.equal(replaceInLocators(`page.getByTestId('aXb')`, 'a.b', 'c').changes.length, 0, '. must not match any character');
  });

  test('line endings and everything else in the file are preserved byte for byte', () => {
    const src = `a\r\nawait page.getByTestId('${FROM}').click();\r\n\r\nend`;
    const r = rename(src);
    assert.equal(r.text, src.replace(FROM, TO));
    assert.equal(verifyOnlySubstitution(src, r.text, FROM, TO).ok, true);
  });

  test('several occurrences on one line and across lines are all renamed, with the changed lines reported', () => {
    const src = `page.getByTestId('${FROM}'); page.getByTestId("${FROM}");\nok();\npage.locator('[data-cy=${FROM}]');`;
    const r = rename(src);
    assert.deepEqual(r.changes.map((c) => c.line), [1, 3]);
    assert.ok(!r.text.includes(FROM));
  });
});

describe('verifyOnlySubstitution: the guard behind "never edits assertions"', () => {
  const before = `await expect(page.getByTestId('${FROM}')).toHaveText('Add');`;
  test('passes when only the id differs', () => {
    assert.deepEqual(verifyOnlySubstitution(before, before.replace(FROM, TO), FROM, TO), { ok: true });
  });
  test('fails when an expected value changed too', () => {
    const r = verifyOnlySubstitution(before, `await expect(page.getByTestId('${TO}')).toHaveText('Added');`, FROM, TO);
    assert.equal(r.ok, false);
    assert.match(r.reason, /line 1 differs by more than the id/);
  });
  test('fails when a matcher changed', () => {
    assert.equal(verifyOnlySubstitution(before, `await expect(page.getByTestId('${TO}')).not.toHaveText('Add');`, FROM, TO).ok, false);
  });
  test('fails when a line that never contained the old id changed', () => {
    const r = verifyOnlySubstitution('a\nb', 'a\nc', FROM, TO);
    assert.match(r.reason, /line 2 changed but never contained "add-to-cart"/);
  });
  test('fails when lines were added or removed', () => {
    assert.match(verifyOnlySubstitution('a', 'a\nb', FROM, TO).reason, /number of lines changed/);
    assert.match(verifyOnlySubstitution('a\nb', 'a', FROM, TO).reason, /number of lines changed/);
  });
  test('is conservative: a line that already contained the NEW id cannot be proven and is refused', () => {
    const line = `x('${TO}'); page.getByTestId('${FROM}')`;
    assert.equal(verifyOnlySubstitution(line, line.replace(FROM, TO), FROM, TO).ok, false);
  });
  test('unchanged content passes trivially', () => {
    assert.deepEqual(verifyOnlySubstitution('same\nlines', 'same\nlines', FROM, TO), { ok: true });
  });
});

describe('collectFiles: what may be edited', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-heal-core-'));
  const w = (rel, content = 'x') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); return f; };
  // collectFiles returns REAL paths (that is how it enforces containment), and on macOS /tmp is a symlink to /private/tmp
  const a = fs.realpathSync(w('tests/a.spec.ts')); const b = fs.realpathSync(w('tests/sub/b.test.js')); const c = fs.realpathSync(w('tests/c.py')); const d = fs.realpathSync(w('tests/d.rb'));
  w('tests/notes.md'); w('tests/data.json'); w('tests/node_modules/lib/x.js'); w('tests/.git/hook.js'); w('tests/dist/out.js'); w('app/src/app.js'); w('tests/big.js', 'x'.repeat(MAX_BYTES + 1));
  const outside = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.js'), 'x');
  fs.symlinkSync(outside, path.join(root, 'tests', 'linked'));
  fs.symlinkSync(path.join(outside, 'secret.js'), path.join(root, 'tests', 'link.js'));

  test('only test-code extensions under the allowed directory; skips dependencies, build output, big files', () => {
    const r = collectFiles({ root, cwd: root, dirs: ['tests'] });
    assert.deepEqual(r.files.sort(), [a, b, c, d].sort());
    assert.deepEqual(r.refused, []);
  });
  test('application source outside the allowed directory is never in scope', () => {
    assert.ok(!collectFiles({ root, cwd: root, dirs: ['tests'] }).files.some((f) => f.includes(`${path.sep}app${path.sep}`)));
  });
  test('symbolic links are never followed (a link out of the directory cannot widen what is editable)', () => {
    const files = collectFiles({ root, cwd: root, dirs: ['tests'] }).files;
    assert.ok(!files.some((f) => f.includes('secret.js') || f.includes('linked')));
  });
  test('a directory that resolves outside the repository, or does not exist, is refused', () => {
    assert.match(collectFiles({ root, cwd: root, dirs: ['../'] }).refused[0], /resolves outside the repository/);
    assert.match(collectFiles({ root, cwd: root, dirs: [outside] }).refused[0], /resolves outside the repository/);
    assert.match(collectFiles({ root, cwd: root, dirs: ['tests/linked'] }).refused[0], /resolves outside the repository/, 'a symlinked directory given explicitly is checked by its real path');
    assert.match(collectFiles({ root, cwd: root, dirs: ['nope'] }).refused[0], /no such directory/);
    assert.match(collectFiles({ root, cwd: root, dirs: ['tests/c.py'] }).refused[0], /not a directory/);
  });
  test('directories are relative to the run directory, and the same file is never listed twice', () => {
    const r = collectFiles({ root, cwd: path.join(root, 'tests'), dirs: ['.', 'sub'] });
    assert.equal(r.files.length, new Set(r.files).size);
    assert.ok(r.files.includes(b));
  });
});

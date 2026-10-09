'use strict';

// The pure, mechanical part of self-heal: what may be edited, how, and the check that proves nothing else changed.
// No git here and no writing — heal.js does that — so every rule can be tested exhaustively.
//
// The one fix is a test-id RENAME inside locator expressions. Everything else about a test (matchers, expected values,
// control flow, other ids) is out of reach by construction, and verifyOnlySubstitution() checks that it stayed that way.
const fs = require('fs');
const path = require('path');

// Ids end up inside source code. The NEW one comes from the page's HTML, which is not trusted: a quote, bracket or
// semicolon in it would be code injection into a test file. So ids are restricted to characters that cannot break out of
// a string or a selector.
const SAFE_ID = /^[A-Za-z0-9_:.-]+$/;
const isSafeTestId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 120 && SAFE_ID.test(id);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Each pattern has three groups: (everything before the id)(the id)(everything after). Only group 2 is ever replaced, so
// an id that happens to equal part of the surrounding syntax ("testid") can never damage it.
function locatorPatterns(id) {
  const e = escapeRe(id);
  return [
    // getByTestId('x') / queryByTestId / findByTestId / getAllByTestId   (Playwright, Testing Library, Cypress plugins)
    new RegExp(`(\\b(?:get|query|find)(?:All)?ByTestId\\(\\s*['"\`])(${e})(['"\`]\\s*\\))`, 'g'),
    // get_by_test_id("x")   (Playwright for Python)
    new RegExp(`(\\bget_by_test_id\\(\\s*['"])(${e})(['"]\\s*\\))`, 'g'),
    // [data-testid=x]  [data-testid="x"]  [data-cy='x']  "[data-testid=\\"x\\"]"   (CSS selectors in any tool, any quoting)
    new RegExp(`(\\[\\s*data-(?:testid|test-id|test|cy|qa)\\s*=\\s*\\\\?['"]?)(${e})(\\\\?['"]?\\s*\\])`, 'g'),
  ];
}

// Replace the id in locator expressions only. Returns the new text and the lines that changed.
function replaceInLocators(text, from, to) {
  const patterns = locatorPatterns(from);
  const changes = [];
  const lines = String(text).split('\n').map((line, i) => {
    let next = line;
    for (const re of patterns) next = next.replace(re, (m, before, id, after) => `${before}${to}${after}`);
    if (next !== line) changes.push({ line: i + 1, before: line, after: next });
    return next;
  });
  return { text: lines.join('\n'), changes };
}

// Lines that still mention the old id after the rename (a constant, a comment, a string the patterns do not cover). They are
// NOT edited — reported so a human knows the heal was partial.
function leftovers(text, from) {
  return String(text).split('\n').map((l, i) => ({ line: i + 1, text: l.trim().slice(0, 140) })).filter((l) => l.text.includes(from));
}

// THE guard. Every changed line must be exactly the original line with `to` swapped back for `from`; every other line must be
// identical; nothing added or removed. If a matcher, an expected value or a second id changed, this is false.
function verifyOnlySubstitution(before, after, from, to) {
  const a = String(before).split('\n'); const b = String(after).split('\n');
  if (a.length !== b.length) return { ok: false, reason: 'the number of lines changed' };
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    if (!a[i].includes(from)) return { ok: false, reason: `line ${i + 1} changed but never contained "${from}"` };
    if (b[i].split(to).join(from) !== a[i]) return { ok: false, reason: `line ${i + 1} differs by more than the id` };
  }
  return { ok: true };
}

const DEFAULT_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'qa-results', 'test-results', 'playwright-report', '__pycache__', '.venv', 'venv']);
const MAX_BYTES = 1024 * 1024;

// The test files that may be edited: under the allowed directories, test-code extensions only, no symlinks, nothing outside
// the repository. `dirs` are relative to `cwd`; every one must resolve inside `root`.
function collectFiles({ root, cwd, dirs, exts = DEFAULT_EXTS }) {
  const realRoot = fs.realpathSync(root);
  const files = []; const refused = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue; // never follow a link out of the allowed directory
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); } else if (e.isFile() && exts.has(path.extname(e.name).toLowerCase()) && fs.statSync(p).size <= MAX_BYTES) files.push(p);
    }
  };
  for (const d of dirs) {
    const abs = path.resolve(cwd, d);
    let real;
    try { real = fs.realpathSync(abs); } catch { refused.push(`${d}: no such directory`); continue; }
    if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) { refused.push(`${d}: resolves outside the repository`); continue; }
    if (!fs.statSync(real).isDirectory()) { refused.push(`${d}: not a directory`); continue; }
    walk(real);
  }
  return { files: [...new Set(files)], refused };
}

module.exports = { isSafeTestId, locatorPatterns, replaceInLocators, leftovers, verifyOnlySubstitution, collectFiles, DEFAULT_EXTS, SKIP_DIRS, MAX_BYTES };

'use strict';
// A throwaway git project with one stale selector, for the self-heal tests: tests/ui.test.js looks for the test-id "coupon-apply-btn", the page
// (app/index.html) has "coupon-apply". Committed on main.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cleanEnv } = require('./node-env');

const IDENT = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test' };
// heal.js commits with the real process.env, so the identity has to be there too: a developer's global git config hides this, a CI runner has none
Object.assign(process.env, IDENT);
const baseEnv = () => cleanEnv(IDENT);
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

// files:    more files to commit (path -> content)
// remote:   also create a bare repository as `origin` and push main to it (state().remoteRefs then shows what origin holds)
// hook:     the text of a pre-commit hook
// extraGit: (projectDir) => void, run after the first commit, for set-up the test needs
// Returns { root, proj, remote, w(rel, content), cfg(triageBlock) -> path, read(rel), state() }; the caller removes `root`.
function makeProject({ files = {}, remote: withRemote = false, hook, extraGit } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-heal-'));
  const proj = path.join(root, 'proj');
  const remote = path.join(root, 'remote.git');
  const w = (rel, content) => { const f = path.join(proj, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };
  w('app/index.html', INDEX); w('tests/page.js', PAGE_JS); w('tests/ui.test.js', UI_TEST);
  for (const [rel, content] of Object.entries(files)) w(rel, content);
  if (withRemote) { fs.mkdirSync(remote); git(remote, 'init', '-q', '--bare', '-b', 'main'); }
  git(proj, 'init', '-q', '-b', 'main'); git(proj, 'add', '-A'); git(proj, 'commit', '-q', '-m', 'initial');
  if (withRemote) { git(proj, 'remote', 'add', 'origin', remote); git(proj, 'push', '-q', 'origin', 'main'); }
  if (hook) fs.writeFileSync(path.join(proj, '.git', 'hooks', 'pre-commit'), hook, { mode: 0o755 });
  if (extraGit) extraGit(proj);
  const cfg = (triage) => { const f = path.join(root, `cfg-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify({ triage })); return f; };
  const state = () => ({
    head: git(proj, 'rev-parse', 'HEAD'),
    branch: git(proj, 'branch', '--show-current'),
    branches: git(proj, 'branch', '--format=%(refname:short)'),
    status: git(proj, 'status', '--porcelain', '--untracked-files=no'),
    ...(withRemote ? { remoteRefs: git(proj, 'ls-remote', 'origin') } : {}),
  });
  return { root, proj, remote, w, cfg, read: (rel) => fs.readFileSync(path.join(proj, rel), 'utf8'), state };
}

module.exports = { IDENT, baseEnv, git, INDEX, PAGE_JS, UI_TEST, makeProject };

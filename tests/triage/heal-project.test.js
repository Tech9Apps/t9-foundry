'use strict';
// tests/helpers/node-env.js and tests/helpers/heal-project.js: what the self-heal tests stand on. A wrong helper here would make those tests
// pass or fail for the wrong reason, so each property they rely on is checked once, here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanEnv } = require('../helpers/node-env');
const { IDENT, baseEnv, git, makeProject, INDEX, UI_TEST } = require('../helpers/heal-project');

test('cleanEnv drops NODE_TEST_CONTEXT, keeps the rest, adds what it is given, and leaves process.env alone', () => {
  process.env.NODE_TEST_CONTEXT = 'child-v8';
  process.env.QA_PROBE = 'kept';
  try {
    const env = cleanEnv({ EXTRA: '1' });
    assert.equal('NODE_TEST_CONTEXT' in env, false);
    assert.equal(env.QA_PROBE, 'kept');
    assert.equal(env.EXTRA, '1');
    assert.equal(process.env.NODE_TEST_CONTEXT, 'child-v8', 'the running test keeps its own context');
    assert.equal('EXTRA' in process.env, false);
  } finally { delete process.env.NODE_TEST_CONTEXT; delete process.env.QA_PROBE; }
});

test('a nested `node --test` started with cleanEnv runs its own tests (the failure the helper exists to prevent)', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || require('node:os').tmpdir(), 'qa-nested-'));
  fs.writeFileSync(path.join(dir, 'inner.test.js'), "require('node:test')('inner runs', () => {});\n");
  process.env.NODE_TEST_CONTEXT = 'child-v8';
  try {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(dir, 'inner.test.js')], { env: cleanEnv(), encoding: 'utf8' });
    assert.match(r.stdout, /^ok 1 - .*inner\.test\.js|# pass 1/m);
  } finally { delete process.env.NODE_TEST_CONTEXT; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('baseEnv is cleanEnv plus the git identity the heal tests commit with', () => {
  process.env.NODE_TEST_CONTEXT = 'x';
  try {
    const env = baseEnv();
    assert.equal('NODE_TEST_CONTEXT' in env, false);
    for (const [k, v] of Object.entries(IDENT)) assert.equal(env[k], v);
  } finally { delete process.env.NODE_TEST_CONTEXT; }
});

test('makeProject builds a committed repository on main holding the stale-selector project', () => {
  const p = makeProject();
  assert.equal(git(p.proj, 'branch', '--show-current'), 'main');
  assert.equal(git(p.proj, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(git(p.proj, 'status', '--porcelain'), '');
  assert.equal(p.read('app/index.html'), INDEX);
  assert.equal(p.read('tests/ui.test.js'), UI_TEST);
  assert.ok(fs.existsSync(path.join(p.proj, 'tests', 'page.js')));
  fs.rmSync(p.root, { recursive: true, force: true });
});

test('makeProject adds extra files, can write more later with `w`, and can run extra git set-up', () => {
  const seen = [];
  const p = makeProject({ files: { 'tests/extra.test.js': 'x\n', 'deep/dir/f.txt': 'y\n' }, extraGit: (proj) => seen.push(proj) });
  assert.equal(p.read('tests/extra.test.js'), 'x\n');
  assert.equal(p.read('deep/dir/f.txt'), 'y\n');
  assert.deepEqual(seen, [p.proj]);
  assert.equal(git(p.proj, 'ls-files', 'deep/dir/f.txt'), 'deep/dir/f.txt', 'extra files are committed');
  p.w('late.txt', 'z\n');
  assert.equal(p.read('late.txt'), 'z\n');
  fs.rmSync(p.root, { recursive: true, force: true });
});

test('makeProject has no remote unless asked, and then a bare origin that holds main', () => {
  const none = makeProject();
  assert.equal(git(none.proj, 'remote'), '');
  assert.equal('remoteRefs' in none.state(), false);
  const withRemote = makeProject({ remote: true });
  assert.equal(git(withRemote.proj, 'remote'), 'origin');
  assert.match(withRemote.state().remoteRefs, /refs\/heads\/main/);
  assert.equal(git(withRemote.remote, 'rev-parse', 'main'), git(withRemote.proj, 'rev-parse', 'HEAD'));
  for (const p of [none, withRemote]) fs.rmSync(p.root, { recursive: true, force: true });
});

test('makeProject installs a pre-commit hook when given one, and `cfg` writes a config holding the triage block', () => {
  const p = makeProject({ hook: '#!/bin/sh\nexit 1\n' });
  assert.ok(fs.statSync(path.join(p.proj, '.git', 'hooks', 'pre-commit')).mode & 0o100, 'the hook is executable');
  const file = p.cfg({ selfHeal: { enabled: true } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { triage: { selfHeal: { enabled: true } } });
  fs.rmSync(p.root, { recursive: true, force: true });
});

test('state() changes when the repository changes, and is equal when it does not', () => {
  const p = makeProject();
  const before = p.state();
  assert.deepEqual(p.state(), before);
  assert.deepEqual(Object.keys(before).sort(), ['branch', 'branches', 'head', 'status']);
  git(p.proj, 'switch', '-q', '-c', 'other');
  assert.notDeepEqual(p.state(), before);
  assert.equal(p.state().branch, 'other');
  git(p.proj, 'switch', '-q', 'main');
  fs.appendFileSync(path.join(p.proj, 'app', 'index.html'), 'dirty\n');
  assert.notEqual(p.state().status, before.status);
  fs.rmSync(p.root, { recursive: true, force: true });
});

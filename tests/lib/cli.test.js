'use strict';
// scripts/lib/cli.js: what every script's command line and JSON reading rest on. The wording of these errors is part of what the
// scripts print (tests/results/run.test.js pins "needs a value" and "unknown option" at the script level too).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { usage, codedError, unreadable, readJson, writeJson, jsonPrinter, parseFlags } = require('../../scripts/lib/cli');

const throwsUsage = (fn, re) => assert.throws(fn, (e) => e.isUsage === true && re.test(e.message));

test('usage() makes an error the scripts print as a usage problem (exit 2)', () => {
  const e = usage('nope');
  assert.ok(e instanceof Error);
  assert.equal(e.message, 'nope');
  assert.equal(e.isUsage, true);
});

test('codedError() makes an error that carries a machine-readable code, which is not a usage error', () => {
  const e = codedError('NOT_FOUND', 'no files');
  assert.ok(e instanceof Error);
  assert.deepEqual([e.code, e.message, e.isUsage], ['NOT_FOUND', 'no files', undefined]);
});

test('unreadable() makes an error with the UNREADABLE code, and is not a usage error', () => {
  const e = unreadable('cannot read x');
  assert.equal(e.code, 'UNREADABLE');
  assert.equal(e.isUsage, undefined);
});

// ── parseFlags ───────────────────────────────────────────────────────────────────
const FLAGS = {
  '--source': { key: 'source' },
  '--timeout-ms': { key: 'timeoutMs', parse: Number },
  '--dry-run': { key: 'dryRun', set: true },
  '--no-heal': { key: 'heal', set: false },
  '--spec': { key: 'specs', list: true },
  '--shout': { key: 'shout', parse: (v, flag) => `${flag}=${v.toUpperCase()}` },
};

test('a flag with a value sets its key; a flag with `set` takes no value and sets that constant', () => {
  assert.deepEqual(parseFlags(['--source', 'github', '--dry-run'], FLAGS), { source: 'github', dryRun: true });
  assert.deepEqual(parseFlags(['--no-heal'], FLAGS), { heal: false });
});

test('`parse` converts the value, and is told which flag it came from', () => {
  assert.equal(parseFlags(['--timeout-ms', '250'], FLAGS).timeoutMs, 250);
  assert.ok(Number.isNaN(parseFlags(['--timeout-ms', 'abc'], FLAGS).timeoutMs), 'a non-number stays NaN for the caller to reject');
  assert.equal(parseFlags(['--shout', 'hi'], FLAGS).shout, '--shout=HI');
});

test('a `list` flag collects every occurrence, and only creates the array when it is used', () => {
  assert.deepEqual(parseFlags(['--spec', 'a', '--spec', 'b'], FLAGS).specs, ['a', 'b']);
  assert.equal('specs' in parseFlags([], FLAGS), false);
});

test('`init` seeds defaults, and a list flag appends to a seeded array', () => {
  assert.deepEqual(parseFlags([], FLAGS, { init: { specs: [], op: 'fetch' } }), { specs: [], op: 'fetch' });
  assert.deepEqual(parseFlags(['--spec', 'a'], FLAGS, { init: { specs: [] } }).specs, ['a']);
});

test('`init` is not shared between calls', () => {
  const init = { specs: [] };
  parseFlags(['--spec', 'a'], FLAGS, { init });
  assert.deepEqual(init.specs, [], 'the caller\'s object is left alone');
  assert.deepEqual(parseFlags(['--spec', 'b'], FLAGS, { init }).specs, ['b']);
});

test('a flag missing its value is a usage error naming the flag', () => {
  throwsUsage(() => parseFlags(['--source'], FLAGS), /^--source needs a value$/);
  throwsUsage(() => parseFlags(['--dry-run', '--spec'], FLAGS), /^--spec needs a value$/);
});

test('an unknown flag is a usage error naming it', () => {
  throwsUsage(() => parseFlags(['--bogus'], FLAGS), /^unknown option --bogus$/);
  throwsUsage(() => parseFlags(['stray'], FLAGS), /^unknown option stray$/);
});

test('a value is whatever follows its flag, even if it looks like a flag (the scripts have always behaved so)', () => {
  assert.equal(parseFlags(['--source', '--dry-run'], FLAGS).source, '--dry-run');
});

test('a flag name only matches exactly', () => {
  throwsUsage(() => parseFlags(['--sourc', 'x'], FLAGS), /unknown option --sourc/);
  throwsUsage(() => parseFlags(['--source=github'], FLAGS), /unknown option --source=github/);
});

test('inherited object keys are not flags', () => {
  throwsUsage(() => parseFlags(['constructor'], FLAGS), /unknown option constructor/);
  throwsUsage(() => parseFlags(['--__proto__', 'x'], FLAGS), /unknown option --__proto__/);
  throwsUsage(() => parseFlags(['toString'], FLAGS), /unknown option toString/);
});

test('with `positionals`, a bare word is collected in `_`, but a dashed unknown is still refused', () => {
  const opts = parseFlags(['file.txt', '--source', 'x'], FLAGS, { positionals: true });
  assert.deepEqual(opts, { source: 'x', _: ['file.txt'] });
  assert.deepEqual(parseFlags([], FLAGS, { positionals: true }), { _: [] });
  throwsUsage(() => parseFlags(['--bogus'], FLAGS, { positionals: true }), /unknown option --bogus/);
});

test('without `positionals`, there is no `_` key at all', () => {
  assert.equal('_' in parseFlags(['--source', 'x'], FLAGS), false);
});

// ── readJson ─────────────────────────────────────────────────────────────────────
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-cli-'));

test('readJson parses a file', () => {
  const dir = tmp();
  const f = path.join(dir, 'a.json');
  fs.writeFileSync(f, '{"a":1}');
  assert.deepEqual(readJson(f), { a: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJson on a missing or malformed file throws UNREADABLE naming the file and the cause', () => {
  const dir = tmp();
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{nope');
  for (const f of [path.join(dir, 'missing.json'), bad]) {
    assert.throws(() => readJson(f), (e) => e.code === 'UNREADABLE' && e.message.startsWith(`cannot read ${f}: `) && e.message.length > `cannot read ${f}: `.length);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJson lets the caller choose the error, and passes it the finished message', () => {
  const seen = [];
  const fail = (m) => { seen.push(m); return Object.assign(new Error(m), { isUsage: true }); };
  assert.throws(() => readJson('/nonexistent/qa.json', { fail }), (e) => e.isUsage === true);
  assert.match(seen[0], /^cannot read \/nonexistent\/qa\.json: /);
});

test('readJson with `unwrap` returns the `data` of a { ok, data } document, and the document itself otherwise', () => {
  const dir = tmp();
  const wrapped = path.join(dir, 'w.json'); const plain = path.join(dir, 'p.json'); const nul = path.join(dir, 'n.json');
  fs.writeFileSync(wrapped, '{"ok":true,"data":{"tests":[]}}');
  fs.writeFileSync(plain, '{"tests":[1]}');
  fs.writeFileSync(nul, 'null');
  assert.deepEqual(readJson(wrapped, { unwrap: true }), { tests: [] });
  assert.deepEqual(readJson(plain, { unwrap: true }), { tests: [1] });
  assert.equal(readJson(nul, { unwrap: true }), null);
  assert.deepEqual(readJson(wrapped), { ok: true, data: { tests: [] } }, 'without `unwrap` the document is returned as is');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── writeJson ────────────────────────────────────────────────────────────────────
test('writeJson writes indented JSON with a trailing newline, creating the folders above the file', () => {
  const dir = tmp();
  const f = path.join(dir, 'a', 'b', 'out.json');
  writeJson(f, { ok: true, list: [1] });
  assert.equal(fs.readFileSync(f, 'utf8'), '{\n  "ok": true,\n  "list": [\n    1\n  ]\n}\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeJson replaces an existing file, and a relative path is written relative to the working directory', () => {
  const dir = tmp();
  const f = path.join(dir, 'out.json');
  fs.writeFileSync(f, 'old');
  writeJson(f, { n: 2 });
  assert.deepEqual(readJson(f), { n: 2 });
  const prev = process.cwd();
  try {
    process.chdir(dir);
    writeJson('rel/x.json', { r: 1 });
    assert.deepEqual(readJson(path.join(dir, 'rel', 'x.json')), { r: 1 });
  } finally { process.chdir(prev); }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── jsonPrinter ──────────────────────────────────────────────────────────────────
test('jsonPrinter writes each document to the stream as indented JSON with a newline, one write per document', () => {
  const writes = [];
  const out = jsonPrinter({ write: (x) => writes.push(x) });
  out({ ok: true });
  out([1, 2]);
  assert.deepEqual(writes, ['{\n  "ok": true\n}\n', '[\n  1,\n  2\n]\n']);
});

test('jsonPrinter reads the stream when it is called, not when it is made', () => {
  const stream = { write: () => {} };
  const out = jsonPrinter(stream);
  const writes = [];
  stream.write = (x) => writes.push(x);
  out({});
  assert.equal(writes.length, 1);
});

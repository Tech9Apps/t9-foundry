'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main, FLAGS, OPS } = require('../../scripts/ledger/cli');
const { ledgerConfig, validate, DEFAULTS, LIMITS, KNOWN } = require('../../scripts/ledger/lib/config');
const schema = require('../../qa-config.schema.json');

const CLI = path.join(__dirname, '..', '..', 'scripts', 'ledger', 'cli.js');
const stream = () => { const s = { text: '', write(t) { s.text += t; } }; return s; };

let dir;
let work;
beforeEach(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ledger-cli-')); dir = path.join(work, 'ledger'); });
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

// runs the CLI in this process; returns { code, json, stderr }
function cli(argv, env = {}) {
  const stdout = stream();
  const stderr = stream();
  const code = main({ argv, env: { ...env }, stdout, stderr });
  return { code, json: stdout.text ? JSON.parse(stdout.text) : null, stderr: stderr.text };
}
const withDir = (...argv) => [...argv, '--dir', dir];

describe('ledger CLI', () => {
  test('claim, complete, then claim again: the second claimant is told it is done, with the result', () => {
    const a = cli(withDir('claim', '--key', 'k1', '--run-id', 'r1'));
    assert.equal(a.code, 0);
    assert.equal(a.json.data.won, true);
    const mid = cli(withDir('claim', '--key', 'k1', '--run-id', 'r2'));
    assert.equal(mid.code, 0, 'losing is data, not an error');
    assert.deepEqual([mid.json.data.won, mid.json.data.state, mid.json.data.ownerAlive], [false, 'in-flight', true]);
    assert.equal(cli(withDir('complete', '--key', 'k1', '--id', '42', '--url', 'https://t/42')).code, 0);
    const done = cli(withDir('claim', '--key', 'k1', '--run-id', 'r2'));
    assert.deepEqual([done.json.data.won, done.json.data.state, done.json.data.claim.result], [false, 'done', { id: '42', url: 'https://t/42' }]);
  });

  test('fail makes the key claimable again; --deduplicated is recorded', () => {
    cli(withDir('claim', '--key', 'k', '--run-id', 'r1'));
    assert.equal(cli(withDir('fail', '--key', 'k', '--code', 'HTTP_500', '--message', 'upstream down')).code, 0);
    assert.equal(cli(withDir('claim', '--key', 'k', '--run-id', 'r2')).json.data.won, true);
    cli(withDir('complete', '--key', 'k', '--id', '7', '--deduplicated'));
    assert.deepEqual(cli(withDir('claim', '--key', 'k')).json.data.claim.result, { id: '7', deduplicated: true });
  });

  test('status on a ledger that does not exist is empty and creates nothing', () => {
    const r = cli(withDir('status'));
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.data.runs, { total: 0, finished: 0, unfinished: [] });
    assert.equal(fs.existsSync(dir), false);
  });

  test('show prints one run and what could not be read in it', () => {
    const { openLedger } = require('../../scripts/ledger/lib/ledger');
    const l = openLedger({ dir });
    l.record('r1', 'run.start', { pid: 1, host: 'h' });
    l.record('r1', 'run.end', { exit: 0, complete: true });
    const r = cli(withDir('show', '--run-id', 'r1'));
    assert.deepEqual([r.json.data.events.length, r.json.data.finished, r.json.data.warnings], [2, true, []]);
  });

  test('prune: a dry run lists, nothing is removed; retention comes from the config unless a flag says otherwise', () => {
    const { openLedger } = require('../../scripts/ledger/lib/ledger');
    const l = openLedger({ dir });
    l.record('old', 'run.start', { pid: 1, host: 'h' });
    const file = path.join(dir, 'runs', fs.readdirSync(path.join(dir, 'runs'))[0]);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(file, old, old);
    const config = path.join(work, 'qa-config.json');
    fs.writeFileSync(config, JSON.stringify({ ledger: { dir, retentionDays: 7 } }));
    const dry = cli(['prune', '--dry-run', '--config', config]);
    assert.equal(dry.json.data.runs.length, 1, 'the config says 7 days, the run is 30 days old');
    assert.equal(fs.existsSync(file), true);
    assert.equal(cli(['prune', '--dry-run', '--config', config, '--run-days', '60']).json.data.runs.length, 0, 'a flag beats the config');
    assert.equal(cli(['prune', '--config', config]).json.data.runs.length, 1);
    assert.equal(fs.existsSync(file), false);
  });

  test('the directory comes from --dir, else ledger.dir in the config, else .qa-ledger', () => {
    const config = path.join(work, 'qa-config.json');
    fs.writeFileSync(config, JSON.stringify({ ledger: { dir: path.join(work, 'from-config') } }));
    assert.equal(cli(['claim', '--key', 'k', '--config', config]).code, 0);
    assert.equal(fs.existsSync(path.join(work, 'from-config', 'keys')), true);
    assert.equal(cli(['claim', '--key', 'k2', '--config', config, '--dir', dir]).code, 0);
    assert.equal(fs.existsSync(path.join(dir, 'keys')), true, '--dir beats the config');
  });

  test('usage mistakes exit 2 with a message and print nothing on stdout', () => {
    const bad = [
      [[], /Usage/],
      [['frobnicate'], /unknown operation "frobnicate"/],
      [withDir('claim'), /claim needs --key/],
      [withDir('complete'), /complete needs --key/],
      [withDir('fail', '--key', 'k'), /fail needs --code/],
      [withDir('show'), /show needs --run-id/],
      [withDir('status', '--nope'), /unknown option --nope/],
      [['claim', '--dir', dir, '--key'], /--key needs a value/],
      [withDir('prune', '--run-days', '0'), /--run-days must be a whole number/],
      [withDir('prune', '--key-days', 'soon'), /--key-days must be a whole number/],
    ];
    for (const [argv, re] of bad) {
      const r = cli(argv);
      assert.equal(r.code, 2, JSON.stringify(argv));
      assert.equal(r.json, null, JSON.stringify(argv));
      assert.match(r.stderr, re, JSON.stringify(argv));
    }
  });

  test('a bad config is a usage error that names the key', () => {
    const config = path.join(work, 'qa-config.json');
    for (const [block, re] of [[{ retentionDays: 0 }, /"ledger.retentionDays"/], [{ retentionDays: 'x' }, /"ledger.retentionDays"/], [{ dir: '' }, /"ledger.dir"/], [{ colour: 'red' }, /unknown key "ledger.colour"/], [null, /"ledger" must be an object/], [[], /"ledger" must be an object/]]) {
      fs.writeFileSync(config, JSON.stringify({ ledger: block }));
      const r = cli(['status', '--config', config]);
      assert.equal(r.code, 2, JSON.stringify(block));
      assert.match(r.stderr, re, JSON.stringify(block));
    }
  });

  test('a ledger error is exit 1 with a code, as JSON', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'VERSION'), '9\n');
    const r = cli(withDir('claim', '--key', 'k'));
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, 'LEDGER_VERSION');
    const none = cli(withDir('complete', '--key', 'never-claimed'));
    assert.equal(none.code, 1);
  });

  test('as a real process: exit codes and one JSON document on stdout', () => {
    const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', cwd: work, env: { PATH: process.env.PATH } });
    const won = run('claim', '--key', 'k', '--run-id', 'r', '--dir', dir);
    assert.equal(won.status, 0);
    assert.equal(JSON.parse(won.stdout).data.won, true);
    const lost = run('claim', '--key', 'k', '--dir', dir);
    assert.equal(JSON.parse(lost.stdout).data.won, false);
    assert.equal(run('nope').status, 2);
    assert.equal(run('claim', '--dir', dir).status, 2);
  });

  test('FLAGS is the table the drift checks read: every flag has a key, and every operation is listed', () => {
    for (const [flag, spec] of Object.entries(FLAGS)) assert.ok(flag.startsWith('--') && spec.key, flag);
    assert.deepEqual([...OPS].sort(), ['claim', 'complete', 'fail', 'prune', 'show', 'status']);
  });
});

describe('the ledger block of qa-config.json', () => {
  test('no config file at all means the defaults, and says nothing was explicit', () => {
    const here = process.cwd();
    process.chdir(work); // discovery looks in the working directory and the two above it: none of them has a qa-config.json
    try {
      const c = ledgerConfig({ env: {} });
      assert.deepEqual([c.file, c.dir, c.retentionDays, c.explicit], [null, DEFAULTS.dir, DEFAULTS.retentionDays, { dir: false, retentionDays: false }]);
    } finally { process.chdir(here); }
  });

  test('an empty config file is the defaults', () => {
    const f = path.join(work, 'qa-config.json');
    fs.writeFileSync(f, '{}');
    const c = ledgerConfig({ configPath: f, env: {} });
    assert.deepEqual([c.dir, c.retentionDays, c.keyRetentionDays, c.explicit], [DEFAULTS.dir, DEFAULTS.retentionDays, DEFAULTS.keyRetentionDays, { dir: false, retentionDays: false }]);
  });

  test('configured values are used and marked explicit', () => {
    const f = path.join(work, 'qa-config.json');
    fs.writeFileSync(f, JSON.stringify({ ledger: { dir: 'x/y', retentionDays: 30 } }));
    const c = ledgerConfig({ configPath: f, env: {} });
    assert.deepEqual([c.dir, c.retentionDays, c.explicit], ['x/y', 30, { dir: true, retentionDays: true }]);
  });

  test('the loader and qa-config.schema.json agree on the keys, the bounds and the defaults', () => {
    const block = schema.properties.ledger;
    assert.equal(block.additionalProperties, false);
    assert.deepEqual(Object.keys(block.properties).sort(), [...KNOWN].sort());
    assert.deepEqual([block.properties.retentionDays.minimum, block.properties.retentionDays.maximum], LIMITS.retentionDays);
    assert.equal(block.properties.retentionDays.default, DEFAULTS.retentionDays);
    assert.equal(block.properties.dir.default, DEFAULTS.dir);
    assert.equal(validate(undefined, 'x').dir, undefined);
  });

  test('a config the schema accepts, the loader accepts, and the reverse for the bad ones', () => {
    const Ajv = require('../node_modules/ajv');
    const ajv = new Ajv({ allErrors: true, strict: false });
    const ok = ajv.compile(schema);
    const base = require('../../qa-config.example.json'); // a complete, valid config: only the ledger block varies
    for (const [block, good] of [[{ dir: 'a', retentionDays: 1 }, true], [{ retentionDays: 3650 }, true], [{ retentionDays: 3651 }, false], [{ retentionDays: 0 }, false], [{ dir: '' }, false], [{ extra: 1 }, false], [{ retentionDays: 1.5 }, false]]) {
      const f = path.join(work, 'qa-config.json');
      fs.writeFileSync(f, JSON.stringify({ ...base, ledger: block }));
      let loaderOk = true;
      try { ledgerConfig({ configPath: f, env: {} }); } catch { loaderOk = false; }
      assert.equal(ok({ ...base, ledger: block }), good, `schema: ${JSON.stringify(block)}`);
      assert.equal(loaderOk, good, `loader: ${JSON.stringify(block)}`);
    }
  });
});

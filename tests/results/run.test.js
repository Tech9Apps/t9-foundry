'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../../scripts/results/run');
const { plan, SUPPORTED } = require('../../scripts/results/frameworks');

const FIX = path.join(__dirname, '..', 'fixtures', 'results');
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-run.'));
const read = (f) => fs.readFileSync(f, 'utf8');

// A stand-in for child_process.spawn: records the call, optionally writes a report where the framework
// recipe says it will go, then "exits".
function fakeSpawn({ code = 0, report, writeTo = 'playwright', hang = false, spawnError } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null, 'SIGKILL')); };
    setImmediate(() => {
      if (spawnError) return child.emit('error', Object.assign(new Error(spawnError.message || 'spawn failed'), { code: spawnError.code }));
      if (report) {
        const target = writeTo === 'playwright' ? options.env.PLAYWRIGHT_JSON_OUTPUT_NAME : writeTo;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.resolve(FIX, report), target); // `report` is a fixture name or an absolute path
      }
      if (!hang) child.emit('close', code, null);
      return undefined;
    });
    return child;
  };
  return { spawn, calls };
}

async function run(argv, { env = {}, ...fake } = {}) {
  let out = '';
  let err = '';
  const f = fakeSpawn(fake);
  const code = await main({ argv, env, spawn: f.spawn, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, err, json: out ? JSON.parse(out) : null, calls: f.calls };
}

const base = (dir, extra = []) => ['--framework', 'playwright', '--out', path.join(dir, 'qa'), ...extra];

test('a failing run: exit 1, runner output kept off stdout, result.json equals what was printed', async () => {
  const dir = tmp();
  const r = await run(base(dir), { code: 1, report: 'playwright.json' });
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.exitCode, 1);
  assert.deepEqual(r.json.data.totals, { total: 5, passed: 2, failed: 2, skipped: 1, flaky: 1 });
  assert.deepEqual(JSON.parse(read(path.join(dir, 'qa', 'result.json'))), r.json);
  assert.deepEqual(r.calls[0].options.stdio, ['ignore', 2, 2]); // child output → stderr, so stdout stays one JSON document
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--quiet discards the runner output instead of sending it to stderr', async () => {
  const dir = tmp();
  const r = await run(base(dir, ['--quiet']), { code: 1, report: 'playwright.json' });
  assert.equal(r.calls[0].options.stdio, 'ignore');
  assert.equal(r.code, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a passing run: exit 0 and ok', async () => {
  const dir = tmp();
  const pass = path.join(dir, 'pass.json');
  const doc = JSON.parse(read(path.join(FIX, 'playwright.json')));
  doc.suites[0].suites[0].specs = doc.suites[0].suites[0].specs.slice(0, 1); // only the passing spec
  fs.writeFileSync(pass, JSON.stringify(doc));
  const r = await run(base(dir), { code: 0, report: pass, writeTo: 'playwright' }).catch((e) => { throw e; });
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.warnings, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('exit code contradicts the report: nonzero exit but no failures reported is NOT trusted', async () => {
  const dir = tmp();
  const pass = path.join(dir, 'pass.json');
  const doc = JSON.parse(read(path.join(FIX, 'playwright.json')));
  doc.suites[0].suites[0].specs = doc.suites[0].suites[0].specs.slice(0, 1);
  fs.writeFileSync(pass, JSON.stringify(doc));
  const r = await run(base(dir), { code: 137, report: pass });
  assert.equal(r.code, 3);
  assert.equal(r.json.ok, false);
  assert.match(r.json.warnings[0], /exited 137 but its report shows no failures/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('exit 0 but the report has failures: still a failing run, with a warning', async () => {
  const dir = tmp();
  const r = await run(base(dir), { code: 0, report: 'playwright.json' });
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.match(r.json.warnings[0], /exited 0 but its report shows failures/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the runner wrote no report: NO_REPORT (exit 3), with the exit code and the framework hint', async () => {
  const dir = tmp();
  const r = await run(['--framework', 'rspec', '--out', path.join(dir, 'qa')], { code: 1 });
  assert.equal(r.code, 3);
  assert.equal(r.json.error.code, 'NO_REPORT');
  assert.match(r.json.error.message, /rspec exited 1 but wrote no usable report/);
  assert.match(r.json.error.message, /rspec_junit_formatter/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a stale report from an earlier run can never stand in for this one', async () => {
  const dir = tmp();
  const stale = path.join(dir, 'qa', 'raw');
  fs.mkdirSync(stale, { recursive: true });
  fs.copyFileSync(path.join(FIX, 'playwright.json'), path.join(stale, 'results.json'));
  const r = await run(base(dir), { code: 0 }); // runner "succeeds" but writes nothing
  assert.equal(r.code, 3);
  assert.equal(r.json.error.code, 'NO_REPORT');
  assert.equal(fs.existsSync(path.join(stale, 'results.json')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a report with zero tests is NO_REPORT, not a pass', async () => {
  const dir = tmp();
  const empty = path.join(dir, 'empty.json');
  fs.writeFileSync(empty, JSON.stringify({ config: {}, suites: [], stats: {} }));
  const r = await run(base(dir), { code: 0, report: empty });
  assert.equal(r.code, 3);
  assert.match(r.json.error.message, /zero tests/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runner not installed: names the missing command', async () => {
  const dir = tmp();
  const r = await run(base(dir), { spawnError: { code: 'ENOENT' } });
  assert.equal(r.code, 3);
  assert.match(r.json.error.message, /npx is not installed or not on PATH/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a hung run is killed at --timeout-ms and reported as incomplete', async () => {
  const dir = tmp();
  const r = await run(base(dir, ['--timeout-ms', '30']), { hang: true });
  assert.equal(r.code, 3);
  assert.match(r.json.error.message, /killed after 30ms/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--dry-run prints the plan and runs nothing, creates nothing', async () => {
  const dir = tmp();
  const r = await run(base(dir, ['--spec', 'login.spec.ts', '--headed', '--dry-run']));
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'qa')), false);
  assert.equal(r.json.dryRun, true);
  assert.match(r.json.command, /^npx playwright test login\.spec\.ts --headed --reporter=list,json$/);
  assert.deepEqual(r.json.env, ['PLAYWRIGHT_JSON_OUTPUT_NAME']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('framework, test dir and config path default from qa-config.json (explicit flags win)', async () => {
  const dir = tmp();
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ testFramework: { type: 'pytest', testDir: 'tests/e2e', configPath: 'x.ini' } }));
  const r = await run(['--config', cfg, '--out', path.join(dir, 'qa'), '--dry-run']);
  assert.match(r.json.command, /^python -m pytest tests\/e2e -v --junitxml=/);
  const over = await run(['--config', cfg, '--framework', 'jest', '--test-dir', 'src', '--out', path.join(dir, 'qa'), '--dry-run']);
  assert.match(over.json.command, /^npx jest src --verbose --json --outputFile=/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('usage errors: exit 2 with a reason on stderr and nothing on stdout', async () => {
  const dir = tmp();
  const cfgNoFramework = path.join(dir, 'empty-config.json');
  fs.writeFileSync(cfgNoFramework, '{}');
  const cases = [
    [['--framework', 'selenium', '--out', dir], /no built-in structured-results recipe for "selenium"/],
    [['--framework', 'other', '--out', dir], /normalize\.js/],
    [['--out', dir, '--config', cfgNoFramework], /no framework/],
    [['--out', dir, '--config', path.join(dir, 'none.json')], /cannot read .*none\.json/],
    [['--bogus'], /unknown option --bogus/],
    [['--framework', 'jest', '--timeout-ms', '0'], /positive number/],
    [['--framework'], /needs a value/],
  ];
  for (const [argv, re] of cases) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.err, re);
    assert.equal(r.json, null);
  }
  assert.equal((await run([])).code, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REAL run: node --test on a throwaway project, failing then fixed', async () => {
  const dir = tmp();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'a.test.js'), "const t=require('node:test');const a=require('node:assert');\nt('DEMO-7/TC-001: adds',()=>a.equal(1+1,2));\nt('DEMO-7/TC-002: breaks',()=>a.equal(1+1,3));\nt('DEMO-7/TC-003: skipped',{skip:true},()=>{});\n");
  // the inner `node --test` must not think it is a subprocess of THIS test run
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const go = (extra = []) => new Promise((resolve) => {
    let out = '';
    main({ argv: ['--framework', 'node', '--cwd', proj, '--spec', 'a.test.js', '--out', path.join(dir, 'qa'), ...extra], env, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } })
      .then((code) => resolve({ code, json: JSON.parse(out) }));
  });
  const first = await go();
  assert.equal(first.code, 1);
  assert.deepEqual(first.json.data.totals, { total: 3, passed: 1, failed: 1, skipped: 1 });
  const bad = first.json.data.tests.find((t) => t.status === 'failed');
  assert.equal(`${bad.ticket}/${bad.caseId}`, 'DEMO-7/TC-002');
  assert.match(bad.error.details, /2 == 3/);

  fs.writeFileSync(path.join(proj, 'a.test.js'), "const t=require('node:test');const a=require('node:assert');\nt('DEMO-7/TC-001: adds',()=>a.equal(1+1,2));\n");
  const second = await go();
  assert.equal(second.code, 0);
  assert.equal(second.json.ok, true);
  assert.deepEqual(second.json.data.totals, { total: 1, passed: 1, failed: 0, skipped: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- recipes ---------------------------------------------------------------------------------------
test('every supported framework asks for a structured report, and unknown ones have no recipe', () => {
  for (const framework of SUPPORTED) {
    const p = plan({ framework, outDir: 'out/raw' });
    assert.ok(p, framework);
    const everything = [p.command, ...p.args, ...Object.keys(p.env), ...Object.values(p.env)].join(' ');
    assert.match(everything, /json|junit|Junit|JUnit|RspecJunitFormatter|QA_RESULTS_DIR/, `${framework} must request a structured report`);
    assert.ok(path.isAbsolute(p.results), `${framework} results path is absolute`);
    assert.ok(['junit', 'playwright-json', 'jest-json'].includes(p.format));
  }
  for (const framework of ['selenium', 'other', undefined, 'mocha; rm -rf /']) assert.equal(plan({ framework, outDir: 'o' }), null);
});

test('recipes honour specs, config path and headed — and pass each as its own argument (no shell)', () => {
  const weird = 'my spec; echo hi.spec.ts';
  const pw = plan({ framework: 'playwright', outDir: 'o', specs: [weird], configPath: 'pw.config.ts', headed: true });
  assert.deepEqual(pw.args, ['playwright', 'test', weird, '--config', 'pw.config.ts', '--headed', '--reporter=list,json']);
  const cy = plan({ framework: 'cypress', outDir: 'o', specs: ['a.cy.js', 'b.cy.js'], configPath: 'cy.json' });
  assert.deepEqual(cy.args.slice(0, 6), ['cypress', 'run', '--config-file', 'cy.json', '--spec', 'a.cy.js,b.cy.js']);
  assert.match(cy.args.join(' '), /mochaFile=.*results-\[hash\]\.xml/);
  assert.equal(plan({ framework: 'pytest', outDir: 'o', testDir: 'tests' }).args[2], 'tests');
  assert.equal(plan({ framework: 'pytest', outDir: 'o', testDir: 'tests', specs: ['t/x.py'] }).args[2], 't/x.py'); // specs beat the directory
  // node: reporter options must come BEFORE the files, or node hands them to the test file and writes no report
  const nd = plan({ framework: 'node', outDir: 'o', specs: ['a.test.js'] }).args;
  assert.equal(nd[nd.length - 1], 'a.test.js');
  assert.ok(nd.indexOf('--test-reporter=junit') < nd.indexOf('a.test.js'));
  assert.deepEqual(plan({ framework: 'webdriverio', outDir: 'o', configPath: 'wdio.conf.js', specs: ['a', 'b'] }).args, ['wdio', 'wdio.conf.js', '--spec', 'a', 'b']);
});

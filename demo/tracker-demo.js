#!/usr/bin/env node
'use strict';

// "What happens when a tracker is connected?" — the demo's missing half.
//
// Takes the demo's own tickets, test cases and the bugs its real test suite finds, and pushes them
// through the real tracker adapter CLI (scripts/tracker/cli.js) into an in-memory tracker. Only the
// network is replaced: the CLI, adapters, schemas, retry and idempotency logic are the real thing.
//
//   node demo/tracker-demo.js [--tracker github|clickup|azure|gitlab|bitbucket]
//
// No network, no accounts, no ports. Exits 1 if the demo stops behaving as documented.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../scripts/tracker/cli');
const { main: runResults } = require('../scripts/results/run');
const { parseTestCases } = require('../scripts/tracker/lib/test-cases');

const HERE = __dirname;
const MOCKS = {
  github: () => require('../tests/mocks/tracker-mock/github').createGithubMock(),
  clickup: () => require('../tests/mocks/tracker-mock/clickup').createClickupMock(),
  azure: () => require('../tests/mocks/tracker-mock/azure').createAzureMock(),
  gitlab: () => require('../tests/mocks/tracker-mock/gitlab').createGitlabMock(),
  bitbucket: () => require('../tests/mocks/tracker-mock/bitbucket').createBitbucketMock(),
};
const LABEL = { github: 'GitHub Issues', clickup: 'ClickUp', azure: 'Azure DevOps', gitlab: 'GitLab', bitbucket: 'Bitbucket' };

// ── Presentation ────────────────────────────────────────────────────────────────
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s); const dim = (s) => c('2', s); const green = (s) => c('32', s);
const red = (s) => c('31', s); const cyan = (s) => c('36', s);
const say = (s = '') => console.log(`   ${s}`);
const problems = [];
const check = (cond, msg) => { if (!cond) { problems.push(msg); console.log(red(`   ✗ DEMO INTEGRITY: ${msg}`)); } };

// ── Parse the demo's own artifacts ──────────────────────────────────────────────
function section(md, name) {
  const m = md.match(new RegExp(`^#{2,3} ${name}[^\\n]*\\n([\\s\\S]*?)(?=^#{2,3} |$(?![\\s\\S]))`, 'm'));
  return m ? m[1].trim() : '';
}

function parseTicket(file) {
  const md = fs.readFileSync(file, 'utf8');
  const [, id, title] = md.match(/^# (DEMO-\d+): (.+)$/m);
  return {
    id, title,
    description: [section(md, 'Summary'), section(md, 'Description')].filter(Boolean).join('\n\n'),
    acceptance: section(md, 'Acceptance Criteria'),
  };
}

function parseBug(file) {
  const md = fs.readFileSync(file, 'utf8');
  const title = md.split('\n')[0].replace(/^# Bug: /, '');
  const body = md.slice(md.indexOf('**Related ticket:**')).trim();
  const priority = (section(md, 'Severity / Priority').match(/\*\*(High|Medium|Low)/) || [])[1];
  return { title, body, priority };
}

// Run the demo app's own suite through the harness's structured-results runner (no console scraping).
async function runRealSuite(workdir) {
  let out = '';
  const code = await runResults({
    argv: ['--framework', 'node', '--cwd', path.join(HERE, 'app'), '--out', path.join(workdir, 'qa-run'), '--quiet'],
    env: process.env, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} },
  });
  const doc = out ? JSON.parse(out) : null;
  if (!doc || !doc.data) { console.error(`the test run produced no result (exit ${code}): ${doc && doc.error && doc.error.message}`); process.exit(1); }
  const results = doc.data.tests.filter((t) => t.ticket && t.caseId).map((t) => ({ failed: t.status === 'failed', id: `${t.ticket}/${t.caseId}` }));
  return { results, failed: results.filter((r) => r.failed).map((r) => r.id), passed: results.filter((r) => !r.failed).length };
}

// ── The tracker, driven through the real CLI ────────────────────────────────────
function connect(type, workdir) {
  const mock = MOCKS[type]();
  const config = path.join(workdir, `${type}.json`);
  fs.writeFileSync(config, JSON.stringify({ ticketSource: { type, [type]: mock.settings } }));
  async function raw(op, input) {
    let out = '';
    const code = await main({
      argv: [op, '--config', config, '--base-url', mock.baseUrl, '--input', JSON.stringify(input)],
      env: { [mock.tokenEnv]: mock.token }, fetch: mock.fetch,
      stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} },
    });
    return { code, ...JSON.parse(out) };
  }
  async function call(op, input) {
    const r = await raw(op, input);
    if (!r.ok) throw new Error(`${op} failed: ${r.error.code} ${r.error.message}`);
    return r.data;
  }
  return { mock, raw, call };
}

async function main2() {
  const args = process.argv.slice(2);
  const embedded = args.includes('--embedded');
  const ti = args.indexOf('--tracker');
  const type = ti >= 0 ? args[ti + 1] : 'github';
  if (!MOCKS[type]) { console.error(`Unknown tracker "${type}" (choose: ${Object.keys(MOCKS).join(', ')})`); return 2; }

  const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-tracker-demo-'));
  const tracker = connect(type, work);
  const tickets = fs.readdirSync(path.join(HERE, 'tickets')).filter((f) => f.endsWith('.md')).sort().map((f) => parseTicket(path.join(HERE, 'tickets', f)));

  if (!embedded) {
    console.log(bold('Tech9 QA Harness — connected to a tracker'));
    console.log(dim(`An in-memory ${LABEL[type]} stands in for the real tracker. The adapter CLI, schemas, retries and idempotency are real.`));
  }
  const heading = (n, t) => console.log(`\n${cyan(bold(`━━ ${embedded ? 'Act 8 · ' : ''}Step ${n} — ${t} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`))}`);

  // 1. Tickets exist in the tracker --------------------------------------------------
  heading(1, 'The tickets live in the tracker');
  const tid = {}; // demo id -> tracker id
  for (const t of tickets) tid[t.id] = tracker.mock.seedTicket({ title: `${t.id}: ${t.title}`, description: t.description, acceptance: t.acceptance });
  for (const t of tickets) say(`${t.id}  →  ${LABEL[type]} #${tid[t.id]}   ${dim(t.title)}`);

  say('');
  say(`${bold(`$ cli.js fetch --input '{"id":"${tid['DEMO-101']}"}'`)}   ${dim('(the same call for any tracker)')}`);
  const fetched = await tracker.call('fetch', { id: tid['DEMO-101'] });
  say(`  → ${fetched.title}`);
  say(`  → ${fetched.acceptanceCriteria.split('\n').filter((l) => /^\s*\d+\./.test(l)).length} acceptance criteria, source: ${fetched.source}, status: ${fetched.status}`);

  // 2. Post the test cases -----------------------------------------------------------
  const cases = {};
  for (const t of tickets) cases[t.id] = parseTestCases(fs.readFileSync(path.join(HERE, 'expected', `${t.id}-test-cases.md`), 'utf8'));

  async function postTestCases(quiet) {
    let created = 0; let existed = 0;
    for (const t of tickets) {
      const ids = [];
      for (const tc of cases[t.id]) {
        const r = await tracker.call('create-test', { parentId: tid[t.id], tcId: tc.tcId, title: tc.title, description: tc.description, priority: tc.priority, steps: tc.steps, idempotencyKey: `${t.id}-${tc.tcId}` });
        await tracker.call('link', { childId: r.id, parentId: tid[t.id] });
        ids.push(r.id);
        if (r.deduplicated) existed += 1; else created += 1;
      }
      if (!quiet) say(`${t.id}  ${String(cases[t.id].length).padStart(2)} test cases posted and linked to #${tid[t.id]}   ${dim(`(${ids[0]} … ${ids[ids.length - 1]})`)}`);
    }
    return { created, existed };
  }
  heading(2, 'Post the test cases (each one linked to its ticket)');
  const first = await postTestCases(false);
  const totalCases = tickets.reduce((n, t) => n + cases[t.id].length, 0);
  check(first.created === totalCases && first.existed === 0, `expected ${totalCases} new test cases, got ${first.created} new / ${first.existed} existing`);
  say(`${green('✓')} ${first.created} created, steps and priority carried across  ${dim('— each has an idempotency key like DEMO-101-TC-001')}`);

  // 3. Run the real suite; file the bugs it finds --------------------------------------
  heading(3, 'Run the real checks, file what they find');
  const suite = await runRealSuite(work);
  say(`${bold('cd demo/app && npm test')}  →  ${suite.passed} passed, ${suite.failed.length} failed`);
  const bugs = suite.failed.map((id) => {
    const ticket = id.split('/')[0];
    const file = fs.readdirSync(path.join(HERE, 'expected')).find((f) => f.startsWith(`bug-${ticket}-`));
    return { id, ticket, ...parseBug(path.join(HERE, 'expected', file)) };
  });
  async function fileBugs() {
    const out = [];
    for (const b of bugs) out.push({ b, r: await tracker.call('create-bug', { title: b.title, body: b.body, priority: b.priority, labels: ['found-by-harness'], idempotencyKey: `${b.ticket}-bug-${b.id.split('/')[1]}` }) });
    return out;
  }
  const filed = await fileBugs();
  for (const { b, r } of filed) say(`${red('✗')} ${b.id}  →  bug ${LABEL[type]} #${r.id}  ${dim(r.url || '')}\n       ${dim(b.title)}`);
  check(filed.length === 2 && filed.every((f) => !f.r.deduplicated), `expected 2 new bugs, got ${filed.length}`);

  // 4. Report back on each ticket ------------------------------------------------------
  heading(4, 'Report the result on each ticket');
  async function comment(runNo, quiet) {
    let posted = 0; let existed = 0;
    for (const t of tickets) {
      const mine = suite.results.filter((r) => r.id.startsWith(`${t.id}/`));
      const fails = mine.filter((r) => r.failed);
      const links = filed.filter((f) => f.b.ticket === t.id).map((f) => `#${f.r.id}`);
      const body = `Run ${runNo}: ${mine.length - fails.length}/${mine.length} automated checks passed.${fails.length ? ` Failing: ${fails.map((f) => f.id).join(', ')} — filed as ${links.join(', ')}.` : ' Ready for release.'}`;
      const r = await tracker.call('comment', { id: tid[t.id], body, idempotencyKey: `run-${runNo}-${t.id}` });
      if (r.deduplicated) existed += 1; else posted += 1;
      if (!quiet) say(`${t.id}  ${dim('«')} ${body} ${dim('»')}`);
    }
    return { posted, existed };
  }
  const c1 = await comment(1);
  check(c1.posted === tickets.length, 'first run should post one comment per ticket');

  // 5. Where the tracker stands ---------------------------------------------------------
  heading(5, 'What is in the tracker now');
  const made = tracker.mock.createdItems();
  const nBugs = filed.length;
  say(`${tickets.length} stories · ${made.length - nBugs} test cases · ${nBugs} bugs · ${tickets.length} comments`);
  check(made.length === totalCases + nBugs, `tracker holds ${made.length} created items, expected ${totalCases + nBugs}`);

  // 6. Run it all again ------------------------------------------------------------------
  heading(6, 'Run the whole thing again — safe to repeat');
  const again = await postTestCases(true);
  const filedAgain = await fileBugs();
  const c2 = await comment(1, true);
  const createdAgain = again.created + filedAgain.filter((f) => !f.r.deduplicated).length + c2.posted;
  const existedAgain = again.existed + filedAgain.filter((f) => f.r.deduplicated).length + c2.existed;
  say(`${bold(`${createdAgain} created`)}, ${existedAgain} already existed  ${dim('→ nothing duplicated')}`);
  check(createdAgain === 0, `re-run created ${createdAgain} duplicate item(s)`);
  check(tracker.mock.createdItems().length === made.length, 'item count changed on re-run');

  // 7. The failure that creates duplicates elsewhere --------------------------------------
  heading(7, 'The nasty one: the connection drops after the tracker accepted the write');
  const fresh = connect(type, work);
  const bug = { title: 'Totals wrong after discount', body: 'details…', priority: 'High', idempotencyKey: 'demo-lost-response' };
  fresh.mock.inject({ method: 'POST', match: fresh.mock.paths.create, networkError: true, afterCommit: true });
  const lost = await fresh.raw('create-bug', bug);
  say(`${bold('create-bug')}  →  ${red(`${lost.error.code}`)} ${dim(`(retriable: ${lost.error.retriable})`)}  — we never saw the response`);
  say(`tracker actually holds ${bold(String(fresh.mock.createdItems().length))} bug  ${dim('(the write went through)')}`);
  check(lost.ok === false && lost.error.retriable === true && fresh.mock.createdItems().length === 1, 'lost-response setup did not behave as expected');
  const retry = await fresh.call('create-bug', bug);
  say(`${bold('retry, same key')}  →  returns the original ${LABEL[type]} #${retry.id}  ${green(`deduplicated: ${retry.deduplicated}`)}`);
  say(`tracker still holds ${bold(String(fresh.mock.createdItems().length))} bug  ${green('✓ no duplicate')}`);
  check(retry.deduplicated === true && fresh.mock.createdItems().length === 1, 'retry after a lost response created a duplicate');
  say(dim('Writes are never retried automatically; a key makes the retry safe.'));

  console.log('');
  if (problems.length) { console.log(red(`The tracker demo found ${problems.length} integrity problem(s).`)); return 1; }
  if (!embedded) say(dim('Same flow, other trackers:  node demo/tracker-demo.js --tracker clickup | azure | gitlab | bitbucket'));
  return 0;
}

if (require.main === module) main2().then((code) => { process.exitCode = code; });

module.exports = { parseTicket, parseTestCases, parseBug };

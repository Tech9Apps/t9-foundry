#!/usr/bin/env node
'use strict';

// Scenario evals for the ticket-to-tracker pipeline.
//
// Each scenario is a real ticket from the demo project with GOLDEN expectations (counts that were
// verified independently of this code). The runner drives the real CLIs — fetch (with the context
// file), post-tests, create-bug, comment — against every in-process tracker mock and checks the
// outcome, including the failure drills that create duplicates in less careful systems.
//
//   node evals/run.js [--tracker github|clickup|azure] [--scenario <substring>] [--json]
//
// Deterministic: no network, no model. This is the layer a model-generated artifact must pass
// through; model-in-the-loop evals can reuse these scenarios and goldens later.
// Exit 0 = every check passed.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { main: cliMain } = require(path.join(ROOT, 'scripts/tracker/cli'));
const { parseTestCases } = require(path.join(ROOT, 'scripts/tracker/lib/test-cases'));
const { parseTicket, parseBug } = require(path.join(ROOT, 'demo/tracker-demo'));
const { workspace, MOCKS } = require(path.join(ROOT, 'tests/tracker/workspace'));
const { assertValid } = require(path.join(ROOT, 'tests/tracker/helpers'));

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const wantTrackers = opt('--tracker') ? [opt('--tracker')] : Object.keys(MOCKS);
const wantScenario = opt('--scenario');
const asJson = args.includes('--json');

const SCENARIOS_DIR = process.env.EVALS_SCENARIOS_DIR || path.join(__dirname, 'scenarios'); // override: used by the tests to prove a wrong golden fails
const scenarios = fs.readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(SCENARIOS_DIR, f), 'utf8')) }))
  .filter((s) => !wantScenario || s.name.toLowerCase().includes(wantScenario.toLowerCase()));

const eq = (actual, expected, what) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const truthy = (cond, what) => { if (!cond) throw new Error(what); };

async function cli(ws, op, input, extra = []) {
  let out = '';
  const code = await cliMain({
    argv: [op, '--config', ws.config, '--base-url', ws.mock.baseUrl, '--input', JSON.stringify(input), ...extra],
    env: { [ws.mock.tokenEnv]: ws.mock.token }, fetch: ws.mock.fetch,
    stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} },
  });
  return { code, ...JSON.parse(out) };
}

function checksFor(scenario, type) {
  const g = scenario.golden;
  const casesFile = path.join(ROOT, scenario.cases);
  const ticket = parseTicket(path.join(ROOT, scenario.ticket));
  const fresh = () => workspace(type, { casesFile, title: `${ticket.id}: ${ticket.title}`, description: ticket.description, acceptance: ticket.acceptance, parentName: ticket.id });
  const settled = async (ws, what) => {
    truthy(ws.mock.createdItems().filter((i) => /^TC-/.test(i.title)).length === g.cases, `${what}: expected exactly ${g.cases} test cases in the tracker, found ${ws.mock.createdItems().filter((i) => /^TC-/.test(i.title)).length}`);
    const keys = ws.keys();
    assertValid('test-keys', keys);
    truthy(keys.tests.length === g.cases && keys.tests.every((t) => t.linked && ['created', 'deduplicated'].includes(t.status)), `${what}: keys file does not show all ${g.cases} cases created and linked`);
  };

  const checks = [
    ['plan: priorities and steps match the golden counts', async () => {
      const ws = fresh();
      const r = await ws.post(['--dry-run'], { env: {} });
      eq(r.json.total, g.cases, 'case count');
      const prio = {};
      r.json.tests.forEach((t) => { prio[t.priority] = (prio[t.priority] || 0) + 1; });
      eq(prio, g.priorities, 'priority distribution');
      truthy(r.json.tests.every((t) => t.steps > 0), 'every case has steps');
      eq(ws.mock.calls.length, 0, 'dry-run requests');
    }],
    ['fetch: ticket and pipeline context file are right', async () => {
      const ws = fresh();
      const target = path.join(ws.dir, 'ctx', `${ticket.id}.json`);
      const r = await cli(ws, 'fetch', { id: ws.parent }, ['--context-file', target]);
      truthy(r.ok, `fetch failed: ${JSON.stringify(r.error)}`);
      const ctx = JSON.parse(fs.readFileSync(target, 'utf8'));
      eq(ctx.summary, g.ticketTitle, 'summary');
      eq(ctx.acceptanceCriteria.split('\n').filter((l) => /^\s*\d+\./.test(l)).length, g.acceptanceCriteria, 'acceptance criteria');
      for (const k of ['ticketId', 'summary', 'issueType', 'status', 'priority', 'labels', 'description', 'acceptanceCriteria', 'attachments', 'comments', 'subtasks']) truthy(k in ctx, `context lacks "${k}"`);
    }],
    ['post: every case created, carried across, and linked', async () => {
      const ws = fresh();
      const r = await ws.post();
      truthy(r.code === 0 && r.json.ok, `post failed: ${r.out}`);
      eq([r.json.created, r.json.linked, r.json.failed, r.json.skipped], [g.cases, g.cases, 0, 0], 'created/linked/failed/skipped');
      await settled(ws, 'after post');
      const parsed = parseTestCases(fs.readFileSync(casesFile, 'utf8'));
      const items = ws.mock.createdItems();
      for (const c of parsed) {
        const item = items.find((i) => i.title.startsWith(`${c.tcId}:`));
        truthy(item, `${c.tcId} is missing from the tracker`);
        const probe = c.steps[0].action.replace(/[`*"']/g, '').slice(0, 24);
        truthy(item.text.replace(/[`*"']/g, '').includes(probe), `${c.tcId}: its first step ("${probe}") did not reach the tracker`);
      }
    }],
    ['re-run: nothing duplicated', async () => {
      const ws = fresh();
      await ws.post();
      const again = await ws.post();
      eq([again.json.created, again.json.deduplicated], [0, g.cases], 'created/deduplicated on re-run');
      await settled(ws, 'after re-run');
    }],
    ['drill: a transient failure mid-run → re-run converges to the same state', async () => {
      const ws = fresh();
      ws.mock.inject({ method: 'POST', match: ws.mock.paths.create, status: 500 });
      const r = await ws.post();
      eq([r.code, r.json.failed], [1, 1], 'first run');
      const retry = await ws.post();
      truthy(retry.code === 0, 'retry should succeed');
      await settled(ws, 'after retry');
    }],
    ['drill: a lost response (write happened, we never heard) → no duplicate', async () => {
      const ws = fresh();
      ws.mock.inject({ method: 'POST', match: ws.mock.paths.create, networkError: true, afterCommit: true });
      const r = await ws.post();
      eq(r.code, 1, 'first run exit code');
      const retry = await ws.post();
      truthy(retry.code === 0, 'retry should succeed');
      await settled(ws, 'after retry');
    }],
    ['drill: credentials revoked mid-run → stops early, re-run converges', async () => {
      const ws = fresh();
      ws.mock.inject({ method: 'POST', match: ws.mock.paths.create, status: 401 });
      const r = await ws.post();
      eq([r.json.failed, r.json.skipped], [1, g.cases - 1], 'failed/skipped');
      const retry = await ws.post();
      truthy(retry.code === 0, 'retry should succeed');
      await settled(ws, 'after retry');
    }],
    ['drill: a wrong parent id creates nothing', async () => {
      const ws = fresh();
      const r = await ws.post([], { parentId: ws.mock.missingId });
      eq([r.code, r.json.ok, r.json.error.code], [1, false, 'NOT_FOUND'], 'outcome');
      eq(ws.mock.createdItems().length, 0, 'items created');
    }],
    ['results comment: posted once however often it is retried', async () => {
      const ws = fresh();
      const input = { id: ws.parent, body: `Run 1: results for ${ticket.id}.`, idempotencyKey: `results-${ticket.id}-20260102T000000Z` };
      const a = await cli(ws, 'comment', input);
      const b = await cli(ws, 'comment', input);
      eq([a.data.deduplicated, b.data.deduplicated], [false, true], 'deduplicated flags');
      eq(ws.mock.commentsOn(ws.parent).filter((c) => c.includes('Run 1')).length, 1, 'comments on the ticket');
    }],
  ];

  for (const bug of g.bugs) {
    const report = parseBug(path.join(ROOT, bug.report));
    checks.push([`bug: "${report.title.slice(0, 40)}…" filed once, findable, re-file deduped`, async () => {
      const ws = fresh();
      const input = { title: report.title, body: report.body, priority: report.priority, labels: ['found-by-harness'], idempotencyKey: `bug-${path.basename(bug.report, '.md')}` };
      eq(report.priority, bug.priority, 'bug priority parsed from the report');
      const dupesBefore = await cli(ws, 'search', { query: bug.searchQuery, kind: 'bug' });
      eq(dupesBefore.data.items.length, 0, 'bug search before filing');
      const a = await cli(ws, 'create-bug', input);
      truthy(a.ok && !a.data.deduplicated, `first create-bug: ${JSON.stringify(a)}`);
      const found = await cli(ws, 'search', { query: bug.searchQuery, kind: 'bug' });
      truthy(found.data.items.some((i) => i.id === a.data.id), 'the filed bug is not found by search');
      const b = await cli(ws, 'create-bug', input);
      eq([b.data.deduplicated, b.data.id], [true, a.data.id], 're-file');
      eq(ws.mock.createdItems().length, 1, 'bugs in the tracker');
    }]);
  }
  return checks;
}

(async () => {
  const rows = [];
  for (const scenario of scenarios) {
    for (const type of wantTrackers) {
      for (const [name, fn] of checksFor(scenario, type)) {
        let error = null;
        try { await fn(); } catch (e) { error = e.message; }
        rows.push({ scenario: scenario.name, tracker: type, check: name, ok: !error, error });
      }
    }
  }
  const failed = rows.filter((r) => !r.ok);
  if (asJson) {
    console.log(JSON.stringify({ ok: failed.length === 0, total: rows.length, failed: failed.length, results: rows }, null, 2));
  } else {
    for (const scenario of scenarios) {
      console.log(`\n${scenario.name}`);
      const names = [...new Set(rows.filter((r) => r.scenario === scenario.name).map((r) => r.check))];
      for (const name of names) {
        const cells = wantTrackers.map((t) => { const r = rows.find((x) => x.scenario === scenario.name && x.tracker === t && x.check === name); return `${t} ${r.ok ? '✓' : '✗'}`; });
        console.log(`  ${cells.join('  ')}   ${name}`);
      }
    }
    for (const r of failed) console.log(`\n✗ [${r.tracker}] ${r.scenario} — ${r.check}\n    ${r.error}`);
    console.log(`\n${failed.length ? '✗' : '✓'} ${rows.length - failed.length}/${rows.length} checks passed  (${scenarios.length} scenarios × ${wantTrackers.length} trackers)`);
  }
  process.exitCode = failed.length ? 1 : 0;
})();

'use strict';

// The Phase 2 exit criterion, end to end: each seeded scenario in demo/scenarios (a real bug, a stale selector, a
// flaky test, an environment outage) is RUN FOR REAL — real node processes, real re-runs, real error messages — then
// triaged and planned, and must end in the classification and step that docs/phase-2-design.md says it should.
// The goldens are in demo/scenarios/manifest.json, written by hand; nothing here is regenerated from the classifier.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../scripts/triage/orchestrate');
const { RULES, CLASSES } = require('../../scripts/triage/classify');
const { MOCKS } = require('../tracker/workspace');

const ROOT = path.join(__dirname, '..', '..');
const manifest = require('../../demo/scenarios/manifest.json');
const scn = (id) => manifest.scenarios.find((s) => s.id === id);

const { cleanEnv: baseEnv } = require('../helpers/node-env'); // the inner `node --test` must not think it is a subprocess of this test run

// Drive one scenario through the real orchestrator with a tracker mock for the plan step.
async function drive(s, { extra = [], mock = MOCKS.github(), snapshot = true } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-scn-'));
  const cfg = path.join(dir, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ ticketSource: { type: 'github', github: mock.settings } }));
  const env = { ...baseEnv(), [mock.tokenEnv]: mock.token, ...(s.stateDir ? { QA_SCENARIO_STATE: path.join(dir, 'state') } : {}) };
  const argv = ['--framework', 'node', '--cwd', path.join(ROOT, s.cwd), ...s.specs.flatMap((x) => ['--spec', x]), '--out', path.join(dir, 'qa'), '--preflight', 'ok', '--run-id', 'r1',
    '--config', cfg, '--base-url', mock.baseUrl, ...(s.snapshot && snapshot ? ['--snapshot', path.join(ROOT, s.snapshot)] : []), ...extra];
  let out = '';
  const code = await main({ argv, env, fetch: mock.fetch, stdout: { write: (x) => { out += x; } }, stderr: { write: () => {} } });
  const json = JSON.parse(out);
  const file = (name) => JSON.parse(fs.readFileSync(path.join(dir, 'qa', name), 'utf8'));
  return { code, json, mock, dir, triage: () => file('triage.json').data, plan: () => file('plan.json').data, flaky: () => file('flaky.json') };
}
const keyOf = (e) => `${e.ticket}/${e.caseId}`;

describe('the manifest', () => {
  test('is well formed: known classes and rules, and every spec file exists', () => {
    assert.deepEqual(manifest.scenarios.map((s) => s.id), ['real-bug', 'stale-selector', 'flaky', 'env-outage']);
    for (const s of manifest.scenarios) {
      assert.ok(fs.existsSync(path.join(ROOT, s.cwd)), s.id);
      for (const spec of s.specs) assert.ok(fs.existsSync(path.join(ROOT, s.cwd, spec)), `${s.id}: ${spec}`);
      if (s.snapshot) assert.ok(fs.existsSync(path.join(ROOT, s.snapshot)), `${s.id}: snapshot`);
      for (const e of s.expect) { assert.ok(CLASSES.includes(e.class), e.class); assert.ok(RULES.includes(e.rule), e.rule); assert.ok(['act', 'propose'].includes(e.action)); }
    }
  });
});

describe('seeded scenarios, run for real', () => {
  for (const s of manifest.scenarios) {
    test(`${s.id}: ${s.what} → ${s.expect.map((e) => `${e.class} (${e.rule})`).join(', ')}`, async () => {
      const r = await drive(s);
      assert.equal(r.code, 0, JSON.stringify(r.json));
      assert.equal(r.json.data.status, 'triaged');
      assert.equal(r.json.data.runs, 3, 'the main run plus two re-runs');
      const got = Object.fromEntries(r.triage().verdicts.map((v) => [v.key, v]));
      assert.deepEqual(Object.keys(got).sort(), s.expect.map(keyOf).sort(), 'exactly the expected tests are triaged — no more, no fewer');
      const steps = Object.fromEntries(r.plan().actions.map((a) => [a.key, a.step]));
      for (const e of s.expect) {
        const v = got[keyOf(e)];
        assert.deepEqual([v.class, v.rule, v.action], [e.class, e.rule, e.action], `${keyOf(e)}: ${v.evidence.join(' | ')}`);
        assert.equal(steps[keyOf(e)], e.step, keyOf(e));
      }
    });
  }

  test('only the real bug ever reaches the tracker: nothing is filed anywhere, and the other scenarios do not even search it', async () => {
    for (const s of manifest.scenarios) {
      const mock = MOCKS.github();
      await drive(s, { mock });
      assert.equal(mock.createdItems().length, 0, `${s.id}: planning files nothing`);
      if (s.id !== 'real-bug') assert.equal(mock.calls.length, 0, `${s.id}: no product bug, so the tracker is not touched`);
    }
  });

  test('flaky.json lists the flaky test with its flip, and only that scenario produces one', async () => {
    const r = await drive(scn('flaky'));
    const f = r.flaky();
    assert.equal(f.runId, 'r1');
    assert.deepEqual(f.flaky.map((x) => x.key), ['DEMO-102/TC-902']);
    assert.deepEqual(f.flaky[0].attempts.map((a) => a.status), ['failed', 'passed', 'passed']);
    assert.deepEqual((await drive(scn('real-bug'))).flaky().flaky, []);
  });
});

describe('seeded scenarios, varied', () => {
  test('real bug, an OPEN report with its fingerprint already exists → comment on it, do not file again', async () => {
    const mock = MOCKS.github();
    const first = await drive(scn('real-bug'), { mock });
    const v = first.triage().verdicts.find((x) => x.key === 'DEMO-101/TC-005');
    mock.seedIssue({ title: '[BUG] Second code stacks', body: `Apply the code twice.\n\nqa-harness-fingerprint: ${v.token}`, labels: ['bug'] });
    const again = await drive(scn('real-bug'), { mock });
    const byKey = Object.fromEntries(again.plan().actions.map((a) => [a.key, a]));
    assert.equal(byKey['DEMO-101/TC-005'].step, 'comment-existing');
    assert.match(byKey['DEMO-101/TC-005'].commentInput.body, new RegExp(v.token));
    assert.equal(byKey['DEMO-102/TC-006'].step, 'file-bug', 'the other bug is still new');
  });

  test('real bug, but the only report is CLOSED → a regression: file a new bug that links it', async () => {
    const mock = MOCKS.github();
    const first = await drive(scn('real-bug'), { mock });
    const v = first.triage().verdicts.find((x) => x.key === 'DEMO-102/TC-006');
    mock.seedIssue({ title: '[BUG] Shipping on discounted subtotal', body: `old\n\nqa-harness-fingerprint: ${v.token}`, labels: ['bug'], state: 'closed' });
    const a = (await drive(scn('real-bug'), { mock })).plan().actions.find((x) => x.key === 'DEMO-102/TC-006');
    assert.equal(a.step, 'file-regression');
    assert.ok(a.regressionOf.id);
  });

  test('real bug with no re-runs: only PROPOSED (a flake cannot be ruled out)', async () => {
    const r = await drive(scn('real-bug'), { extra: ['--reruns', '0'] });
    assert.equal(r.json.data.runs, 1);
    assert.deepEqual([...new Set(r.triage().verdicts.map((v) => `${v.rule}:${v.action}`))], ['PRD-3:propose']);
    assert.deepEqual([...new Set(r.plan().actions.map((a) => a.step))], ['propose']);
  });

  test('stale selector without a DOM snapshot: the evidence is missing, so it is a proposal and NEVER a bug', async () => {
    const r = await drive(scn('stale-selector'), { snapshot: false });
    const v = r.triage().verdicts[0];
    assert.deepEqual([v.class, v.rule, v.action], ['undetermined', 'UND-1', 'propose']);
    assert.match(v.evidence[0], /locators\.js/);
    assert.deepEqual(r.plan().actions.map((a) => a.step), ['propose']);
  });

  test('environment outage with a failed preflight: no re-runs, ENV-1', async () => {
    const r = await drive(scn('env-outage'), { extra: ['--preflight', 'failed'] });
    assert.equal(r.json.data.runs, 1);
    assert.deepEqual(r.triage().verdicts.map((v) => [v.class, v.rule]), [['environment', 'ENV-1']]);
  });
});

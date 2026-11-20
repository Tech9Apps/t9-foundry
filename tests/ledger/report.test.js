'use strict';

// Slice 5: the run summary (scripts/ledger/lib/summary.js), the Slack path (slack.js), the `report` config block and the command that ties them together
// (scripts/report.js). The summary is deterministic text from events: these tests hold what it says, what it refuses to say, and that nothing in a run can
// reach a person as markup, a mention or a link.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { summarize, renderMarkdown, renderSlack, slackSafe, plain, duration, MAX_ROWS } = require('../../scripts/ledger/lib/summary');
const { slackTarget, postSlack, DEFAULT_HOST, MAX_BODY_BYTES, HOST } = require('../../scripts/ledger/lib/slack');
const { reportConfig, KNOWN, MAX_HOSTS } = require('../../scripts/ledger/lib/report-config');
const { openLedger } = require('../../scripts/ledger/lib/ledger');
const { main } = require('../../scripts/report');
const { validate } = require('../../scripts/tracker/lib/contract');
const schema = require('../../qa-config.schema.json');

const T0 = Date.parse('2026-11-13T10:00:00Z');
const FP = '0123456789ab';
const TOKEN = `qafp${FP}`;
let work;
let dir;
let clock;
beforeEach(() => { work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-report-')); dir = path.join(work, 'ledger'); clock = T0; });
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));
const open = () => openLedger({ dir, now: () => clock });
const iso = (ms) => new Date(ms).toISOString();

// hand-built events: the renderers read plain objects, so most tests need no ledger
const E = (type, fields = {}, at = 0) => ({ v: 1, ts: iso(T0 + at), runId: 'r1', type, ...fields });
const START = E('run.start', { pid: 1, host: 'h', framework: 'node', ticket: 'T-1' });
const END = (at = 90000, fields = {}) => E('run.end', { exit: 0, complete: true, counts: { total: 3, passed: 1, failed: 2, skipped: 0 }, ...fields }, at);
const verdict = (fields = {}) => E('verdict', { token: TOKEN, class: 'product-bug', confidence: 0.92, action: 'act', test: 'checkout rejects a second code', rule: 'PB-1', ...fields });
const key = (op, fp = FP, run = 'r1', suffix = '') => `github~abcd1234/${op}/fp-${fp}-${run}${suffix}`;
const sum = (events, extra = {}) => summarize({ runId: 'r1', events, ...extra });

describe('what a summary says about a run', () => {
  test('a green run: passed, the numbers, nothing waiting, and spend nobody reported is "not measured"', () => {
    const m = sum([START, E('test.result', { spec: 's', name: 'a', status: 'passed', phase: 'main' }), E('budget', { wallClockMs: 1500 }, 1500), END(1500, { counts: { total: 1, passed: 1, failed: 0, skipped: 0 } })]);
    const md = renderMarkdown(m);
    assert.equal(m.green, true);
    assert.match(md, /^## QA run r1: passed\n/);
    assert.match(md, /\| Tests \| 1 total, 1 passed, 0 failed \|/);
    assert.match(md, /\| Spent \| wall clock 2s · turns not measured · cost not measured \|/);
    assert.match(md, /- Nothing: every step ran and nothing is waiting\./);
    assert.doesNotMatch(md, /### Failures/);
  });

  test('spend that the launcher reported is shown (summed), the wall clock is the last one the run measured, and a budget stop is not a measurement', () => {
    const m = sum([START, E('budget', { turns: 12, costUsd: 0.5 }, 10), E('budget', { turns: 8, costUsd: 0.34 }, 20), E('budget', { wallClockMs: 5000, exceeded: 'wall-clock limit of 4000 ms reached before the plan' }, 30), E('budget', { wallClockMs: 6000 }, 40), END(40)]);
    assert.deepEqual(m.spent, { wallClockMs: 6000, turns: 20, costUsd: 0.84 });
    // a stop recorded AFTER the last measurement must not replace it
    const late = sum([START, E('budget', { wallClockMs: 6000 }, 10), E('budget', { wallClockMs: 9000, exceeded: 'wall-clock limit of 4000 ms reached before the plan' }, 20), END(30, { exit: 5, complete: false })]);
    assert.equal(late.spent.wallClockMs, 6000);
    assert.match(renderMarkdown(m), /wall clock 6s · turns 20 · cost \$0\.84/);
  });

  test('a run with no run.end (it was killed) is "did not finish", never a pass, whatever it had recorded', () => {
    const m = sum([START, E('test.result', { spec: 's', name: 'a', status: 'passed', phase: 'main' })]);
    const md = renderMarkdown(m);
    assert.equal(m.finished, false);
    assert.equal(m.green, false);
    assert.match(md, /^## QA run r1: did not finish\n/);
    assert.match(md, /\| Finished \| no \|/);
    assert.match(md, /This run did not finish \(there is no run\.end\)/);
    assert.match(md, /\| Tests \| 1 total, 1 passed, 0 failed \|/, 'counted from the results it did record');
  });

  test('a run stopped by its budget says so in the headline and in what was not done, and is not green', () => {
    const why = 'wall-clock limit of 60000 ms reached before the re-runs';
    const m = sum([START, E('budget', { wallClockMs: 90000, exceeded: why }), END(90000, { exit: 5, complete: false })]);
    assert.equal(m.green, false);
    assert.match(renderMarkdown(m), /^## QA run r1: stopped by its budget \(partial\)\n/);
    assert.match(renderMarkdown(m), /- Stopped early: wall-clock limit of 60000 ms reached before the re-runs\./);
  });

  test('a run that ended in an error says which exit', () => {
    assert.match(renderMarkdown(sum([START, END(10, { exit: 3, complete: false, counts: undefined })])), /^## QA run r1: ended with an error \(exit 3\)\n/);
  });

  test('a run where tests failed but the loop finished: the outcome counts the failures, the run is not green', () => {
    const m = sum([START, END()]);
    assert.match(renderMarkdown(m), /^## QA run r1: 2 failed\n/);
    assert.equal(m.green, false);
  });

  test('a run id used twice shares a file: only the last run is summarized', () => {
    const first = [E('run.start', { pid: 1, host: 'h', framework: 'old' }), E('verdict', { token: TOKEN, class: 'flaky', confidence: 0.5, action: 'propose', test: 'from the first run' }), E('run.end', { exit: 0, complete: true, counts: { total: 9, passed: 9, failed: 0 } })];
    const m = sum([...first, E('run.start', { pid: 2, host: 'h', framework: 'new' }, 100), E('run.end', { exit: 0, complete: true, counts: { total: 1, passed: 1, failed: 0 } }, 200)]);
    assert.deepEqual([m.framework, m.verdicts.length], ['new', 0]);
  });

  test('the number of runs the verdicts rest on is the number of phases that were recorded', () => {
    const r = (phase) => E('test.result', { spec: 's', name: 'a', status: 'failed', phase });
    assert.match(renderMarkdown(sum([START, r('main'), r('rerun-1'), r('rerun-2'), END()])), /\| Runs the verdicts rest on \| 3 \(the main run and 2 re-runs\) \|/);
    assert.match(renderMarkdown(sum([START, r('main'), END()])), /\| Runs the verdicts rest on \| 1 \(the main run\) \|/);
  });
});

describe('what happened to each failure', () => {
  const outcomeOfStep = (v, audit = []) => sum([START, verdict(v), END()], { audit }).verdicts[0].outcome;
  const done = (op, id, extra = {}, suffix = '') => ({ type: 'action.done', key: key(op, FP, 'r1', suffix), id, ...extra });

  test('a bug to file that nobody has filed yet is waiting for a person', () => {
    assert.deepEqual(outcomeOfStep({ step: 'file-bug' }), { text: 'waiting for a person: a new bug is to be filed', waiting: true });
  });

  test('a bug that was filed shows its number, and one the ledger already had says it already existed', () => {
    assert.deepEqual(outcomeOfStep({ step: 'file-bug' }, [done('create-bug', '17')]), { text: 'filed #17', waiting: false });
    assert.equal(outcomeOfStep({ step: 'file-bug' }, [done('create-bug', '17', { deduplicated: true })]).text, 'filed #17 (it already existed)');
  });

  test('a filing that failed or that began and never finished is something to do again, with the reason', () => {
    const failed = outcomeOfStep({ step: 'file-bug' }, [{ type: 'action.claimed', key: key('create-bug'), step: 'create-bug' }, { type: 'action.failed', key: key('create-bug'), code: 'HTTP_500' }]);
    assert.deepEqual(failed, { text: 'filing failed (HTTP_500): try again', waiting: true });
    const began = outcomeOfStep({ step: 'file-bug' }, [{ type: 'action.claimed', key: key('create-bug'), step: 'create-bug' }]);
    assert.deepEqual(began, { text: 'filing began and did not finish: check the tracker, then run it again', waiting: true });
  });

  test('a comment on an open report: waiting, or done, and "(ledger)" says the ledger found the report and the tracker search did not', () => {
    assert.equal(outcomeOfStep({ step: 'comment-existing', item: '42', itemFrom: 'ledger' }).text, 'waiting for a person: a comment on #42 (ledger)');
    assert.equal(outcomeOfStep({ step: 'comment-existing', item: '42', itemFrom: 'tracker' }).text, 'waiting for a person: a comment on #42');
    assert.equal(outcomeOfStep({ step: 'comment-existing', item: '42', itemFrom: 'tracker' }, [done('comment', '9001', {}, '-comment')]).text, 'commented on #42');
  });

  test('a regression names the closed report it regresses', () => {
    assert.equal(outcomeOfStep({ step: 'file-regression', item: '30', itemFrom: 'tracker' }).text, 'waiting for a person: a regression of #30 is to be filed');
    assert.equal(outcomeOfStep({ step: 'file-regression', item: '30', itemFrom: 'tracker' }, [done('create-bug', '31')]).text, 'filed #31, a regression of #30');
  });

  test('the steps that never write say what they are, and a dismissed report is named', () => {
    assert.equal(outcomeOfStep({ step: 'report-dismissed', item: '12' }).text, 'not filed: #12 was closed without a fix');
    assert.equal(outcomeOfStep({ step: 'report-dismissed' }).text, 'not filed: the matching report was closed without a fix');
    assert.equal(outcomeOfStep({ step: 'duplicate-in-run' }).text, 'covered by another failure in this run');
    assert.equal(outcomeOfStep({ step: 'propose-test-fix', class: 'test-bug' }).text, 'a test fix is proposed; nothing was edited');
    assert.equal(outcomeOfStep({ step: 'report-flaky', class: 'flaky' }).text, 'reported only (flaky: never filed)');
    assert.equal(outcomeOfStep({ step: 'report-environment', class: 'environment' }).text, 'reported only (environment: never filed)');
    assert.equal(outcomeOfStep({ step: 'propose', action: 'propose' }).text, 'proposed only: not confident enough to act, or held back');
    for (const step of ['report-dismissed', 'duplicate-in-run', 'propose-test-fix', 'report-flaky', 'report-environment', 'propose']) assert.equal(outcomeOfStep({ step }).waiting, false, step);
  });

  test('a failure with no plan says so; an unknown step is shown as planned, never as done', () => {
    assert.deepEqual(outcomeOfStep({}), { text: 'no plan was made for it', waiting: false });
    assert.deepEqual(outcomeOfStep({ step: 'something-new' }), { text: 'planned: something-new', waiting: false });
  });

  test('a write is found by its key whoever the audit record was attributed to, and only for THIS run and THIS failure', () => {
    const mine = { type: 'action.done', runId: 'unattributed', key: key('create-bug'), id: '5' };
    assert.equal(outcomeOfStep({ step: 'file-bug' }, [mine]).text, 'filed #5');
    assert.equal(outcomeOfStep({ step: 'file-bug' }, [{ ...mine, key: key('create-bug', FP, 'r2') }]).waiting, true, 'the same failure filed by another run is not this run\'s filing');
    assert.equal(outcomeOfStep({ step: 'file-bug' }, [{ ...mine, key: key('create-bug', 'ffffffffffff') }]).waiting, true, 'another failure');
    assert.equal(outcomeOfStep({ step: 'file-bug' }, [{ ...mine, key: key('comment') }]).waiting, true, 'a comment is not a bug');
    assert.equal(outcomeOfStep({ step: 'file-bug' }, [{ ...mine, key: key('create-bug', FP, 'r10') }]).waiting, true, 'r10 is not r1');
  });

  test('a long list of waiting writes is cut, and says how many more there are', () => {
    const waiting = Array.from({ length: 35 }, (_, i) => verdict({ token: `qafp${String(i).padStart(12, '0')}`, test: `w${i}`, step: 'file-bug' }));
    const md = renderMarkdown(sum([START, ...waiting, END()]));
    assert.match(md, /- …and 5 more waiting\./);
    assert.equal((md.match(/^- w\d+: waiting for a person/gm) || []).length, 30);
  });

  test('waiting writes are listed under what was not done, held-back ones are counted by kind', () => {
    const md = renderMarkdown(sum([START, verdict({ step: 'file-bug' }), verdict({ token: 'qafp111111111111', step: 'report-flaky', class: 'flaky', test: 'f1' }), verdict({ token: 'qafp222222222222', step: 'report-flaky', class: 'flaky', test: 'f2' }), verdict({ token: 'qafp333333333333', test: 'np' }), END()]));
    assert.match(md, /- checkout rejects a second code: waiting for a person: a new bug is to be filed\./);
    assert.match(md, /- 2 × reported only \(flaky: never filed\)\./);
    assert.match(md, /- 1 failure\(s\) have no plan \(the plan step did not run\)\./);
  });
});

describe('self-heal, flaky tests and warnings', () => {
  test('a heal that was kept is not a problem; one that was reverted, interrupted or never ended is listed', () => {
    const heals = [E('heal.begin', { branch: 'qa/heal-a', baseSha: 'x' }, 1), E('heal.end', { branch: 'qa/heal-a', outcome: 'kept' }, 2), E('heal.begin', { branch: 'qa/heal-b', baseSha: 'x' }, 3), E('heal.end', { branch: 'qa/heal-b', outcome: 'reverted' }, 4),
      E('heal.begin', { branch: 'qa/heal-c', baseSha: 'x' }, 5), E('heal.end', { branch: 'qa/heal-c', outcome: 'interrupted' }, 6), E('heal.begin', { branch: 'qa/heal-d', baseSha: 'x' }, 7)];
    const md = renderMarkdown(sum([START, ...heals, END()]));
    assert.doesNotMatch(md, /heal-a/);
    assert.match(md, /Self-heal on qa\/heal-b: reverted\./);
    assert.match(md, /Self-heal on qa\/heal-c: interrupted\./);
    assert.match(md, /Self-heal on qa\/heal-d: never ended \(the branch may still exist\)\./);
  });

  test('flaky tests: only those seen in THIS run that have flipped, with their rate over recent runs', () => {
    const seen = E('test.result', { spec: 's.js', name: 'wobbly', status: 'passed', phase: 'main' });
    const flake = [{ spec: 's.js', name: 'wobbly', runsSeen: 10, flips: 3, rate: 0.3 }, { spec: 's.js', name: 'elsewhere', runsSeen: 10, flips: 5, rate: 0.5 }, { spec: 's.js', name: 'wobbly', runsSeen: 4, flips: 0, rate: 0 }];
    const md = renderMarkdown(sum([START, seen, END()], { flake }));
    assert.match(md, /- wobbly: flipped in 3 of its last 10 run\(s\) \(30%\)/);
    assert.doesNotMatch(md, /elsewhere/);
    assert.equal((md.match(/wobbly/g) || []).length, 1, 'a stable test of the same name is not listed');
  });

  test('the warnings of the run are listed, with a count', () => {
    const md = renderMarkdown(sum([START, E('warning', { message: 'tracker search failed for a' }), E('warning', { message: '3 of 4 failures are undetermined' }), END()]));
    assert.match(md, /### Warnings \(2\)\n\n- tracker search failed for a\n- 3 of 4 failures are undetermined\n/);
  });
});

describe('a summary is bounded and harmless', () => {
  test('more failures than the table holds: the first MAX_ROWS are listed and the rest are counted', () => {
    const many = Array.from({ length: 60 }, (_, i) => verdict({ token: `qafp${String(i).padStart(12, '0')}`, test: `t${i}`, step: 'report-flaky' }));
    const md = renderMarkdown(sum([START, ...many, END()]));
    assert.equal(MAX_ROWS, 50);
    assert.equal((md.match(/^\| t\d+ \|/gm) || []).length, 50);
    assert.match(md, /…and 10 more failure\(s\) not listed\./);
  });

  test('a test name or a warning cannot break a table, start a line, mention anyone, or carry a secret', () => {
    const nasty = 'a | b\n## injected <@U123> <!channel> @here [x](http://evil) `code` sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
    const md = renderMarkdown(sum([START, verdict({ test: nasty, rule: nasty }), E('warning', { message: nasty }), END()]));
    assert.doesNotMatch(md, /sk-ant-api03/);
    assert.doesNotMatch(md, /\n## injected/);
    assert.doesNotMatch(md, /@here/, 'an @ is followed by a zero-width space, so it mentions nobody');
    assert.doesNotMatch(md, /<@U123>|<!channel>|<b>/);
    assert.doesNotMatch(md, /\[x\]\(/);
    const row = md.split('\n').find((l) => l.includes('injected'));
    assert.equal((row.match(/(?<!\\)\|/g) || []).length, 6, 'five cells: no unescaped | inside one');
  });

  test('numbers from a ledger that was edited by hand cannot put text in a cell', () => {
    const md = renderMarkdown(sum([START, E('run.end', { exit: 0, complete: true, counts: { total: '| x |', passed: '<b>', failed: 0 } }, 10)]));
    assert.match(md, /\| Tests \| \? total, \? passed, 0 failed \|/);
  });

  test('a cell is cut at its limit', () => {
    assert.equal(plain('x'.repeat(500)).length, 160);
    assert.equal(plain('x'.repeat(500), 20), `${'x'.repeat(19)}…`);
  });

  test('the same events always give the same text', () => {
    const ev = [START, verdict({ step: 'file-bug' }), E('warning', { message: 'w' }), END()];
    assert.equal(renderMarkdown(sum(ev)), renderMarkdown(sum(JSON.parse(JSON.stringify(ev)))));
  });

  test('a summary longer than its limit is cut and says so', () => {
    const big = Array.from({ length: 30 }, (_, i) => E('warning', { message: `${i} ${'w'.repeat(380)}` }));
    const long = renderMarkdown(sum([START, ...big, END()]));
    assert.ok(long.length < 60200);
  });

  test('durations read as people say them', () => {
    assert.deepEqual([duration(0), duration(450), duration(1500), duration(90000), duration(3725000), duration(-1), duration(NaN)], ['0 ms', '450 ms', '2s', '1m 30s', '1h 2m 5s', 'unknown', 'unknown']);
  });
});

describe('the Slack text', () => {
  test('a headline, the numbers, a line per failure, the warnings; short', () => {
    const t = renderSlack(sum([START, verdict({ step: 'file-bug' }), E('warning', { message: 'tracker search failed' }), END()]));
    assert.match(t, /^\*QA run r1: 2 failed\*\n3 tests, 1 passed, 2 failed · 1m 30s · wall clock not measured/);
    assert.match(t, /• checkout rejects a second code \(product-bug, 92%\): waiting for a person: a new bug is to be filed/);
    assert.match(t, /warning: tracker search failed/);
  });

  test('nothing in a run can become a mention, a channel ping or a link in Slack', () => {
    const t = renderSlack(sum([START, verdict({ test: '<@U123> <!channel> <https://evil|click> @here & more', step: 'file-bug' }), E('warning', { message: '<!everyone>' }), END()]));
    assert.doesNotMatch(t, /<[@!h]/);
    assert.doesNotMatch(t, /@here/);
    assert.match(t, /&lt;@​U123&gt; &lt;!channel&gt;/);
    assert.match(t, /&amp; more/);
  });

  test('slackSafe undoes the Markdown escapes, then escapes & < >', () => {
    assert.equal(slackSafe('a \\| b \\<c\\> \\\\ & <d>'), 'a | b &lt;c&gt; \\ &amp; &lt;d&gt;');
  });

  test('the text is cut to its limit', () => {
    const t = renderSlack(sum([START, ...Array.from({ length: 5 }, (_, i) => E('warning', { message: `${i} ${'w'.repeat(190)}` })), END()]), { max: 300 });
    assert.ok(t.length <= 300 + 20);
  });
});

describe('where a Slack webhook may point', () => {
  const HOOK = 'https://hooks.slack.com/services/T000/B000/XXXXXXXX';

  test('not set, or blank: nothing is configured (and nothing is said)', () => {
    for (const v of [undefined, null, '', '   ']) assert.deepEqual(slackTarget(v), { configured: false });
  });

  test('https on hooks.slack.com is allowed', () => {
    const t = slackTarget(HOOK);
    assert.deepEqual([t.configured, t.ok, t.url], [true, true, HOOK]);
    assert.equal(slackTarget(' HTTPS://HOOKS.SLACK.COM/services/T/B/X ').ok, true, 'case and surrounding space do not matter');
  });

  test('anything else is refused, and the reason never contains the address', () => {
    const cases = [
      ['not a url', /not a URL/], ['http://hooks.slack.com/services/T/B/X', /https/], ['https://user:pw@hooks.slack.com/services/T/B/X', /user name or password/],
      ['https://hooks.slack.com:8443/services/T/B/X', /default https port/], ['https://evil.example.com/services/T/B/SECRETTOKEN', /host .* is not allowed/],
      ['https://hooks.slack.com.evil.com/services/T/B/SECRETTOKEN', /not allowed/], ['https://evilhooks.slack.com/services/T/B/SECRETTOKEN', /not allowed/], ['https://sub.hooks.slack.com/services/T/B/SECRETTOKEN', /not allowed/],
      ['ftp://hooks.slack.com/x', /https/], ['https://127.0.0.1/services/T/B/SECRETTOKEN', /not allowed/],
    ];
    for (const [raw, re] of cases) {
      const t = slackTarget(raw);
      assert.equal(t.ok, false, raw);
      assert.match(t.reason, re, raw);
      assert.doesNotMatch(t.reason, /SECRETTOKEN|pw@|evil\.example/, 'the address is a credential: it is not repeated');
    }
  });

  test('a host the project names is allowed, exactly, and only then', () => {
    assert.equal(slackTarget('https://hooks.example.com/x', { hosts: ['hooks.example.com'] }).ok, true);
    assert.equal(slackTarget('https://hooks.example.com/x').ok, false);
    assert.equal(slackTarget('https://other.example.com/x', { hosts: ['hooks.example.com'] }).ok, false);
    assert.equal(slackTarget('https://a.hooks.example.com/x', { hosts: ['hooks.example.com'] }).ok, false);
    assert.equal(DEFAULT_HOST, 'hooks.slack.com');
  });
});

describe('posting to Slack', () => {
  const url = 'https://hooks.slack.com/services/T000/B000/XXXXXXXX';
  const answer = (status) => { const calls = []; return { calls, fetch: async (u, init) => { calls.push({ u, init }); return { status }; } }; };

  test('one POST with the text as JSON, redirects not followed, and a timeout', async () => {
    const f = answer(200);
    assert.deepEqual(await postSlack({ url, text: 'hello', fetch: f.fetch }), { ok: true });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].u, url);
    assert.equal(f.calls[0].init.method, 'POST');
    assert.equal(f.calls[0].init.redirect, 'manual');
    assert.equal(f.calls[0].init.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { text: 'hello' });
    assert.ok(f.calls[0].init.signal instanceof AbortSignal);
  });

  test('a refusal or an error from Slack is a reason, never a throw, and never repeats the address', async () => {
    for (const [status, re] of [[500, /answered 500/], [403, /answered 403/], [302, /redirect \(302\)/], [301, /redirect \(301\)/]]) {
      const r = await postSlack({ url, text: 'x', fetch: answer(status).fetch });
      assert.equal(r.ok, false);
      assert.match(r.reason, re);
      assert.doesNotMatch(r.reason, /XXXXXXXX|services/);
    }
    const down = await postSlack({ url, text: 'x', fetch: async () => { throw Object.assign(new Error(`connect ECONNREFUSED ${url}`), { name: 'TypeError' }); } });
    assert.deepEqual(down, { ok: false, reason: 'the message could not be sent (the request failed)' });
    const slow = await postSlack({ url, text: 'x', fetch: async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); } });
    assert.match(slow.reason, /timed out/);
  });

  test('a message over the size limit is not sent at all', async () => {
    const f = answer(200);
    const r = await postSlack({ url, text: 'x'.repeat(MAX_BODY_BYTES), fetch: f.fetch });
    assert.equal(r.ok, false);
    assert.match(r.reason, /larger than 32768 bytes/);
    assert.equal(f.calls.length, 0);
  });
});

describe('the `report` block of qa-config.json', () => {
  const cfg = (obj) => { const f = path.join(work, 'qa-config.json'); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };

  test('no config, no block, an empty block, or an unreadable config: no extra hosts', () => {
    assert.deepEqual(reportConfig({ configPath: path.join(work, 'absent.json'), env: {} }).slackHosts, []);
    for (const body of [{}, { report: {} }, '{ not json', '[]', 'null']) assert.deepEqual(reportConfig({ configPath: cfg(body), env: {} }).slackHosts, [], JSON.stringify(body));
  });

  test('the hosts a project names are read', () => {
    const c = reportConfig({ configPath: cfg({ report: { slackHosts: ['hooks.example.com', 'proxy.corp.example'] } }), env: {} });
    assert.deepEqual([c.present, c.slackHosts], [true, ['hooks.example.com', 'proxy.corp.example']]);
  });

  test('a malformed block is a usage error naming the key', () => {
    for (const [block, re] of [['x', /"report" must be an object/], [{ slackHost: [] }, /unknown key "report\.slackHost"/], [{ slackHosts: 'hooks.example.com' }, /"report\.slackHosts" must be a list/], [{ slackHosts: ['HOOKS.example.com'] }, /report\.slackHosts/], [{ slackHosts: ['https://hooks.example.com'] }, /report\.slackHosts/], [{ slackHosts: ['hooks.example.com:8443'] }, /report\.slackHosts/], [{ slackHosts: ['localhost'] }, /report\.slackHosts/], [{ slackHosts: Array(11).fill('a.example.com') }, /at most 10/], [{ slackHosts: [5] }, /report\.slackHosts/]]) {
      assert.throws(() => reportConfig({ configPath: cfg({ report: block }), env: {} }), (e) => e.isUsage && re.test(e.message), JSON.stringify(block));
    }
  });

  test('the schema and the loader agree', () => {
    const def = schema.properties.report;
    assert.deepEqual(Object.keys(def.properties), KNOWN);
    assert.equal(def.additionalProperties, false);
    assert.equal(def.properties.slackHosts.maxItems, MAX_HOSTS);
    assert.equal(def.properties.slackHosts.items.pattern, HOST.source);
  });
});

describe('scripts/report.js', () => {
  const stream = () => { const s = { text: '', write(t) { s.text += t; } }; return s; };
  async function report(argv, { env = {}, fetch } = {}) {
    const stdout = stream(); const stderr = stream();
    const code = await main({ argv, env, stdout, stderr, fetch, now: () => clock });
    return { code, stdout: stdout.text, stderr: stderr.text, json: () => JSON.parse(stdout.text) };
  }
  // a finished run with one failure that is waiting for a person, in a real ledger
  function seed({ ticket = 'T-1', green = false } = {}) {
    const l = open();
    l.record('r1', 'run.start', { pid: 1, host: 'h', framework: 'node', ...(ticket ? { ticket } : {}) });
    l.record('r1', 'test.result', { spec: 's.js', name: green ? 'ok' : 'bad', status: green ? 'passed' : 'failed', phase: 'main' });
    if (!green) l.record('r1', 'verdict', { token: TOKEN, class: 'product-bug', confidence: 0.9, action: 'act', step: 'file-bug', test: 'bad', rule: 'PB-1' });
    clock += 5000;
    l.record('r1', 'run.end', { exit: 0, complete: true, counts: { total: 1, passed: green ? 1 : 0, failed: green ? 0 : 1, skipped: 0 } });
  }
  const args = (...more) => ['--run-id', 'r1', '--dir', dir, ...more];

  test('prints the summary as Markdown and exits 0', async () => {
    seed();
    const r = await report(args());
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^## QA run r1: 1 failed\n/);
    assert.match(r.stdout, /waiting for a person: a new bug is to be filed/);
    assert.equal(r.stderr, '');
  });

  test('finds the ledger by the project\'s config when --dir is not given', async () => {
    seed();
    const config = path.join(work, 'qa-config.json');
    fs.writeFileSync(config, JSON.stringify({ ledger: { dir } }));
    const r = await report(['--run-id', 'r1', '--config', config]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^## QA run r1/);
  });

  test('shows a filing that went through the ledger, whoever it was attributed to', async () => {
    seed();
    open().audit('unattributed', 'action.done', { key: key('create-bug'), id: '77', url: 'https://x/77' });
    assert.match((await report(args())).stdout, /\| filed #77 \|/);
  });

  test('a run that is not in the ledger is exit 1 with a JSON error, and the ledger is not created', async () => {
    const r = await report(args());
    assert.equal(r.code, 1);
    assert.equal(r.json().error.code, 'RUN_NOT_FOUND');
    assert.match(r.json().error.message, /only recorded when the project has a `ledger` block/);
    assert.equal(fs.existsSync(dir), false);
  });

  test('a bad invocation is exit 2 with a line on stderr: no run id, an odd one, an odd window, an unknown flag, a flag with no value', async () => {
    for (const argv of [['--dir', dir], ['--run-id', ''], ['--run-id', 'x'.repeat(129), '--dir', dir], ['--run-id', 'a\nb'], args('--window', '0'), args('--window', 'x'), args('--bogus'), ['--run-id']]) {
      const r = await report(argv);
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.stderr, /^report: /);
      assert.equal(r.stdout, '');
    }
    assert.equal((await report(['--help'])).code, 0);
    assert.equal((await report([])).code, 2);
  });

  test('a hostile run id cannot leave the ledger', async () => {
    const r = await report(['--run-id', '../../etc/passwd', '--dir', dir]);
    assert.equal(r.code, 1);
    assert.equal(r.json().ok, false);
  });

  test('a malformed `report` block is refused (exit 2) before anything is read or sent', async () => {
    seed();
    const config = path.join(work, 'bad.json');
    fs.writeFileSync(config, JSON.stringify({ report: { slackHosts: 'x' } }));
    const calls = [];
    const r = await report(args('--config', config), { env: { QA_SLACK_WEBHOOK: 'https://hooks.slack.com/x' }, fetch: async (...a) => { calls.push(a); return { status: 200 }; } });
    assert.equal(r.code, 2);
    assert.equal(r.stdout, '');
    assert.equal(calls.length, 0);
  });

  describe('$GITHUB_STEP_SUMMARY', () => {
    test('appended to an existing file, once, after what was already there', async () => {
      seed();
      const f = path.join(work, 'step.md');
      fs.writeFileSync(f, '# earlier\n');
      const r = await report(args(), { env: { GITHUB_STEP_SUMMARY: f } });
      assert.equal(r.code, 0);
      const text = fs.readFileSync(f, 'utf8');
      assert.match(text, /^# earlier\n## QA run r1: 1 failed\n/);
      assert.equal((text.match(/## QA run r1/g) || []).length, 1);
      assert.equal(r.stderr, '');
    });

    test('--no-step-summary leaves it alone', async () => {
      seed();
      const f = path.join(work, 'step.md');
      fs.writeFileSync(f, 'x');
      await report(args('--no-step-summary'), { env: { GITHUB_STEP_SUMMARY: f } });
      assert.equal(fs.readFileSync(f, 'utf8'), 'x');
    });

    test('a path that is not an existing regular file is not written: a link, a folder, a path that is not there. The report still succeeds, with a warning', async () => {
      seed();
      const target = path.join(work, 'precious.txt');
      fs.writeFileSync(target, 'keep');
      const link = path.join(work, 'link.md');
      fs.symlinkSync(target, link);
      const folder = path.join(work, 'a-folder');
      fs.mkdirSync(folder);
      const missing = path.join(work, 'not-there.md');
      for (const p of [link, folder, missing]) {
        const r = await report(args(), { env: { GITHUB_STEP_SUMMARY: p } });
        assert.equal(r.code, 0, p);
        assert.match(r.stderr, /report: the step summary was not written/, p);
        assert.match(r.stdout, /^## QA run r1/, p);
      }
      assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
      assert.equal(fs.existsSync(missing), false);
    });
  });

  describe('--comment-out', () => {
    test('a ticket comment INPUT file in the shape the planner writes, which the tracker contract accepts, with a key that is the same every time', async () => {
      seed();
      const f = path.join(work, 'out', 'comment.json');
      assert.equal((await report(args('--comment-out', f))).code, 0);
      const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
      assert.deepEqual(Object.keys(doc).sort(), ['body', 'id', 'idempotencyKey']);
      assert.equal(doc.id, 'T-1');
      assert.match(doc.body, /^## QA run r1: 1 failed\n/);
      assert.match(doc.body, /\n\nqa-harness-run-report: r1$/);
      assert.match(doc.idempotencyKey, /^report-[0-9a-f]{16}$/);
      assert.doesNotThrow(() => validate('comment', doc), 'the same validation the tracker applies to a comment');
      await report(args('--comment-out', f));
      assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).idempotencyKey, doc.idempotencyKey);
    });

    test('two runs get two keys', async () => {
      seed();
      const l = open();
      l.record('r2', 'run.start', { pid: 1, host: 'h', ticket: 'T-1' });
      l.record('r2', 'run.end', { exit: 0, complete: true });
      const a = path.join(work, 'a.json'); const b = path.join(work, 'b.json');
      await report(args('--comment-out', a));
      await report(['--run-id', 'r2', '--dir', dir, '--comment-out', b]);
      assert.notEqual(JSON.parse(fs.readFileSync(a, 'utf8')).idempotencyKey, JSON.parse(fs.readFileSync(b, 'utf8')).idempotencyKey);
    });

    test('--ticket names the ticket when the run had none, and wins over the run\'s own', async () => {
      seed({ ticket: null });
      const f = path.join(work, 'c.json');
      const none = await report(args('--comment-out', f));
      assert.equal(none.code, 0);
      assert.match(none.stderr, /no comment file was written: this run has no ticket/);
      assert.equal(fs.existsSync(f), false);
      await report(args('--comment-out', f, '--ticket', 'T-9'));
      assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).id, 'T-9');
      fs.rmSync(dir, { recursive: true, force: true });
      seed({ ticket: 'T-1' });
      await report(args('--comment-out', f, '--ticket', 'T-2'));
      assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).id, 'T-2');
    });

    test('a file that cannot be written is a warning, not a failed report', async () => {
      seed();
      const blocker = path.join(work, 'blocker');
      fs.writeFileSync(blocker, 'x');
      const r = await report(args('--comment-out', path.join(blocker, 'c.json')));
      assert.equal(r.code, 0);
      assert.match(r.stderr, /the comment file was not written/);
    });

    test('nothing is written unless asked', async () => {
      seed();
      await report(args());
      assert.deepEqual(fs.readdirSync(work).sort(), ['ledger']);
    });
  });

  describe('Slack', () => {
    const HOOK = 'https://hooks.slack.com/services/T000/B000/XXXXXXXX';
    const recorder = (status = 200) => { const calls = []; return { calls, fetch: async (u, init) => { calls.push({ u, body: JSON.parse(init.body) }); return { status }; } }; };

    test('not set: no request is made and nothing is said', async () => {
      seed();
      const f = recorder();
      const r = await report(args(), { fetch: f.fetch });
      assert.equal(f.calls.length, 0);
      assert.equal(r.stderr, '');
    });

    test('set: one POST of the short text, and the report is unchanged', async () => {
      seed();
      const f = recorder();
      const r = await report(args(), { env: { QA_SLACK_WEBHOOK: HOOK }, fetch: f.fetch });
      assert.equal(r.code, 0);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].u, HOOK);
      assert.match(f.calls[0].body.text, /^\*QA run r1: 1 failed\*/);
      assert.equal(r.stderr, '');
    });

    test('--no-slack never posts; --slack-only-failures posts a failing run and not a green one', async () => {
      seed();
      const a = recorder();
      await report(args('--no-slack'), { env: { QA_SLACK_WEBHOOK: HOOK }, fetch: a.fetch });
      assert.equal(a.calls.length, 0);
      const b = recorder();
      await report(args('--slack-only-failures'), { env: { QA_SLACK_WEBHOOK: HOOK }, fetch: b.fetch });
      assert.equal(b.calls.length, 1, 'a failing run is not quiet');
      fs.rmSync(dir, { recursive: true, force: true });
      seed({ green: true });
      const c = recorder();
      const g = await report(args('--slack-only-failures'), { env: { QA_SLACK_WEBHOOK: HOOK }, fetch: c.fetch });
      assert.equal(c.calls.length, 0, 'a green run is quiet');
      assert.match(g.stdout, /^## QA run r1: passed/);
      const d = recorder();
      await report(args(), { env: { QA_SLACK_WEBHOOK: HOOK }, fetch: d.fetch });
      assert.equal(d.calls.length, 1, 'without the flag a green run is posted too');
    });

    test('a webhook on a host that is not allowed is not used, and the warning does not contain it', async () => {
      seed();
      const f = recorder();
      const r = await report(args(), { env: { QA_SLACK_WEBHOOK: 'https://evil.example.com/services/T/B/SECRETTOKEN' }, fetch: f.fetch });
      assert.equal(r.code, 0);
      assert.equal(f.calls.length, 0);
      assert.match(r.stderr, /report: not posted to Slack: the host of QA_SLACK_WEBHOOK is not allowed/);
      assert.doesNotMatch(r.stderr + r.stdout, /SECRETTOKEN/);
    });

    test('http is refused', async () => {
      seed();
      const f = recorder();
      const r = await report(args(), { env: { QA_SLACK_WEBHOOK: 'http://hooks.slack.com/services/T/B/X' }, fetch: f.fetch });
      assert.equal(f.calls.length, 0);
      assert.match(r.stderr, /must be an https URL/);
    });

    test('a host named in report.slackHosts is used', async () => {
      seed();
      const config = path.join(work, 'qa-config.json');
      fs.writeFileSync(config, JSON.stringify({ report: { slackHosts: ['hooks.example.com'] } }));
      const f = recorder();
      const r = await report(args('--config', config), { env: { QA_SLACK_WEBHOOK: 'https://hooks.example.com/x' }, fetch: f.fetch });
      assert.equal(f.calls.length, 1);
      assert.equal(r.stderr, '');
    });

    test('a failing Slack never fails the report: a status, a redirect and a thrown error are all a warning and exit 0', async () => {
      seed();
      for (const status of [500, 302]) {
        const r = await report(args(), { env: { QA_SLACK_WEBHOOK: HOOK }, fetch: recorder(status).fetch });
        assert.equal(r.code, 0);
        assert.match(r.stderr, /not posted to Slack/);
        assert.match(r.stdout, /^## QA run r1/);
        assert.doesNotMatch(r.stderr, /XXXXXXXX/);
      }
      const r = await report(args(), { env: { QA_SLACK_WEBHOOK: HOOK }, fetch: async () => { throw new Error(`down ${HOOK}`); } });
      assert.equal(r.code, 0);
      assert.doesNotMatch(r.stderr, /XXXXXXXX/, 'the address is not repeated from an error either');
    });
  });
});

describe('docs/ledger.md names only what exists', () => {
  const guide = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'ledger.md'), 'utf8');
  const scriptFlags = require('../helpers/script-flags');
  const ROOT = path.join(__dirname, '..', '..');
  const lines = [...guide.matchAll(/^(?:node (scripts\/[\w/-]+\.js)(.*?))(?:\s+#.*)?$/gm)];

  test('there are commands in it to check', () => assert.ok(lines.length >= 6, `${lines.length}`));

  test('every `node scripts/...` line in it names a real script, and only options that script defines', () => {
    for (const [line, file, rest] of lines) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} (${line})`);
      const flags = scriptFlags(ROOT, file);
      for (const f of rest.matchAll(/(?:^|\s)(--[a-z-]+)/g)) assert.ok(flags.has(f[1]), `${file} has no option ${f[1]}: ${line}`);
    }
  });

  test('every ledger operation it shows is one the ledger CLI has', () => {
    const { OPS } = require('../../scripts/ledger/cli');
    for (const [, file, rest] of lines.filter((l) => l[1].endsWith('ledger/cli.js'))) assert.ok(OPS.includes(rest.trim().split(/\s+/)[0]), rest);
  });

  test('the exit codes and error names it states are the real ones', () => {
    const orch = fs.readFileSync(path.join(ROOT, 'scripts', 'triage', 'orchestrate.js'), 'utf8');
    for (const code of ['COOLDOWN', 'LOCKED']) assert.ok(orch.includes(`'${code}'`), code);
    assert.ok(fs.readFileSync(path.join(ROOT, 'scripts', 'tracker', 'lib', 'errors.js'), 'utf8').includes('IN_PROGRESS'));
    for (const f of ['--no-step-summary', '--slack-only-failures', '--no-slack', '--comment-out']) assert.ok(guide.includes(f), `the guide no longer mentions ${f}`);
  });
});

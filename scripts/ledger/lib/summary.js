'use strict';

// A run summary: deterministic text rendered from one run's ledger events (docs/phase-3-design.md, "Reporting"). Nothing here is model-written and nothing is
// guessed: it says what the events say, so a pass, a failure and a crash render the same way, a killed run (no run.end) is shown as one that did not finish,
// and the text can be snapshot-tested.
//
// Everything in a summary is untrusted DATA (a test name, an error, a warning can hold anything): it is masked again here (a forged ledger may hold what the
// writer would have masked), and every cell is cut down and made harmless in Markdown and in Slack (no table breaks, no @mention, no link, no markup).
const { redactSecrets } = require('../../triage/lib/text');
const { runPart } = require('../../lib/ids');

const MAX_ROWS = 50; // failures listed in a table: the rest are counted
const MAX_LINES = 30; // lines of any other list
const CELL_MAX = 160;
const SUMMARY_MAX_CHARS = 60000;

// What a plan step means, in words. [done, planned-but-not-done] for the steps that write to the tracker; one text for those that never do.
const WRITES = new Set(['file-bug', 'file-regression', 'comment-existing']);
const NEVER_WRITES = {
  'report-dismissed': 'not filed: the matching report was closed without a fix',
  'duplicate-in-run': 'covered by another failure in this run',
  'propose-test-fix': 'a test fix is proposed; nothing was edited',
  'report-flaky': 'reported only (flaky: never filed)',
  'report-environment': 'reported only (environment: never filed)',
  propose: 'proposed only: not confident enough to act, or held back',
};

// Makes text from a run safe to put in a table cell or a line of a message: one line, masked, cut, and without the characters that give Markdown or Slack a table, a link,
// markup or an HTML tag (an underscore is left alone: inside a word it means nothing, and HTTP_500 should read as HTTP_500).
function plain(value, max = CELL_MAX) {
  let s = redactSecrets(String(value === undefined || value === null ? '' : value));
  s = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s.replace(/[\\`*~|<>&[\]]/g, (c) => `\\${c}`).replace(/@/g, '@\u200b');
}

// Markdown escapes (a backslash before the character) do not stop Slack from reading <@U123> or <!channel>: for Slack the escapes are undone and & < > become entities, which
// is what Slack's own documentation asks for in text that is not a message of its own markup.
const slackSafe = (text) => text.replace(/\\([\\`*_~|<>&[\]])/g, '$1').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// a number from the ledger, or "?": a forged one must not carry text into a cell
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '?');

const idOf = (v) => (v === undefined || v === null || v === '' ? '' : `#${plain(v, 40)}`);

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  return h ? `${h}h ${m}m ${r}s` : m ? `${m}m ${r}s` : `${r}s`;
}

// The events of the LAST run in the file (a run id used twice shares a file; a run is one run.start to its run.end).
function lastRun(events) {
  let i = -1;
  events.forEach((e, k) => { if (e.type === 'run.start') i = k; });
  return i < 0 ? events : events.slice(i);
}

// What the tracker writes for one failure were, from the audit log. A write's key carries the fingerprint and the run id's part (docs: plan.js builds
// `fp-<fingerprint>-<runPart>`), so the writes are found whoever the audit record says made them: the agent that files a bug is not told this run's id.
function writesFor(audit, token, runId) {
  const fp = String(token).replace(/^qafp/, '');
  const base = `fp-${fp}-${runPart(runId)}`;
  const mine = audit.filter((e) => typeof e.key === 'string' && (e.key.endsWith(`/create-bug/${base}`) || e.key.endsWith(`/comment/${base}-comment`)));
  const done = mine.find((e) => e.type === 'action.done');
  if (done) return { state: 'done', id: done.id, url: done.url, deduplicated: done.deduplicated === true, op: done.key.includes('/comment/') ? 'comment' : 'create-bug' };
  const failed = [...mine].reverse().find((e) => e.type === 'action.failed');
  if (failed) return { state: 'failed', code: failed.code };
  if (mine.some((e) => e.type === 'action.claimed')) return { state: 'started' };
  return { state: 'none' };
}

// The outcome of one failure: { text, waiting } where `waiting` is a write that was planned and has not happened.
function outcomeOf(v, write) {
  const item = idOf(v.item);
  const from = v.itemFrom === 'ledger' ? ' (ledger)' : '';
  if (!v.step) return { text: 'no plan was made for it', waiting: false };
  if (NEVER_WRITES[v.step]) return { text: v.step === 'report-dismissed' && item ? `not filed: ${item}${from} was closed without a fix` : NEVER_WRITES[v.step], waiting: false };
  if (!WRITES.has(v.step)) return { text: `planned: ${plain(v.step, 40)}`, waiting: false };
  const target = v.step === 'comment-existing' ? `commented on ${item}${from}` : v.step === 'file-regression' ? `filed ${write.id ? idOf(write.id) : 'a new bug'}, a regression of ${item}${from}` : `filed ${write.id ? idOf(write.id) : 'a new bug'}`;
  if (write.state === 'done') return { text: `${target}${write.deduplicated ? ' (it already existed)' : ''}`, waiting: false };
  if (write.state === 'failed') return { text: `${v.step === 'comment-existing' ? 'commenting' : 'filing'} failed (${plain(write.code, 40)}): try again`, waiting: true };
  if (write.state === 'started') return { text: `${v.step === 'comment-existing' ? 'commenting' : 'filing'} began and did not finish: check the tracker, then run it again`, waiting: true };
  return { text: v.step === 'comment-existing' ? `waiting for a person: a comment on ${item}${from}` : `waiting for a person: ${v.step === 'file-regression' ? `a regression of ${item}${from} is to be filed` : 'a new bug is to be filed'}`, waiting: true };
}

// { ... } everything the renderers need. `events` are the run's events (ledger.readRun), `audit` the audit log's events (ledger.readAudit), `flake` the cross-run
// rates for the tests of this run (views.flakeRates), already filtered by the caller or not: it is filtered here against what this run saw.
function summarize({ runId, events, audit = [], flake = [] }) {
  const ev = lastRun(events);
  const start = ev.find((e) => e.type === 'run.start') || null;
  const end = [...ev].reverse().find((e) => e.type === 'run.end') || null;
  const results = ev.filter((e) => e.type === 'test.result');
  const main = results.filter((e) => e.phase === 'main');
  const phases = [...new Set(results.map((e) => e.phase))];
  const counted = (s) => main.filter((e) => e.status === s).length;
  const totals = end && end.counts && typeof end.counts === 'object' ? end.counts : { total: main.length, passed: counted('passed'), failed: counted('failed'), skipped: counted('skipped') };
  const failed = Number.isFinite(totals.failed) ? totals.failed : counted('failed');

  const verdicts = ev.filter((e) => e.type === 'verdict').map((v) => {
    const write = WRITES.has(v.step) ? writesFor(audit, v.token, runId) : { state: 'none' };
    return { token: v.token, test: v.test, rule: v.rule, class: v.class, confidence: v.confidence, action: v.action, step: v.step, item: v.item, itemFrom: v.itemFrom, write, outcome: outcomeOf(v, write) };
  });

  const budgetEvents = ev.filter((e) => e.type === 'budget');
  const spent = { wallClockMs: null, turns: null, costUsd: null };
  for (const b of budgetEvents) {
    if (Number.isFinite(b.wallClockMs) && !b.exceeded) spent.wallClockMs = b.wallClockMs;
    if (Number.isFinite(b.turns)) spent.turns = (spent.turns || 0) + b.turns;
    if (Number.isFinite(b.costUsd)) spent.costUsd = Math.round(((spent.costUsd || 0) + b.costUsd) * 1e6) / 1e6; // (0.5 + 0.34 is not 0.84 in floating point)
  }
  const stoppedBy = budgetEvents.filter((b) => b.exceeded).map((b) => b.exceeded);

  const heals = [];
  for (const b of ev.filter((e) => e.type === 'heal.begin')) {
    const e = ev.find((x) => x.type === 'heal.end' && x.branch === b.branch && x.ts >= b.ts);
    heals.push({ branch: b.branch, outcome: e ? e.outcome : 'never ended' });
  }

  const seen = new Set(results.map((r) => `${r.spec}\u0000${r.name}`));
  const flaky = flake.filter((t) => seen.has(`${t.spec}\u0000${t.name}`) && t.flips > 0);

  const finished = Boolean(end);
  const exit = end ? end.exit : null;
  const durationMs = start && end ? Date.parse(end.ts) - Date.parse(start.ts) : null;
  const outcome = !start ? 'no start recorded' : !finished ? 'did not finish' : stoppedBy.length ? 'stopped by its budget (partial)' : exit !== 0 ? `ended with an error (exit ${exit})` : failed > 0 ? `${failed} failed` : 'passed';

  return {
    runId, started: start ? start.ts : null, ended: end ? end.ts : null, framework: start && start.framework || null, ticket: start && start.ticket || null,
    finished, exit, complete: end ? end.complete === true : false, outcome, durationMs, totals, runs: phases.length, spent, stoppedBy,
    verdicts, flaky, heals, warnings: ev.filter((e) => e.type === 'warning').map((w) => w.message),
    green: finished && exit === 0 && end.complete === true && failed === 0 && stoppedBy.length === 0,
  };
}

const spendLine = (s) => [`wall clock ${s.wallClockMs === null ? 'not measured' : duration(s.wallClockMs)}`, `turns ${s.turns === null ? 'not measured' : s.turns}`, `cost ${s.costUsd === null ? 'not measured' : `$${s.costUsd.toFixed(2)}`}`].join(' · ');
const pct = (r) => `${Math.round(r * 100)}%`;

function notDone(m) {
  const lines = [];
  if (!m.finished) lines.push('This run did not finish (there is no run.end): everything below it is partial, and what it was doing when it stopped is not known.');
  for (const why of m.stoppedBy) lines.push(`Stopped early: ${plain(why, 240)}.`);
  const waiting = m.verdicts.filter((v) => v.outcome.waiting);
  const held = m.verdicts.filter((v) => !v.outcome.waiting && v.step && !WRITES.has(v.step));
  for (const v of waiting.slice(0, MAX_LINES)) lines.push(`${plain(v.test || v.token, 100)}: ${v.outcome.text}.`);
  if (waiting.length > MAX_LINES) lines.push(`…and ${waiting.length - MAX_LINES} more waiting.`);
  const byStep = new Map();
  for (const v of held) byStep.set(v.step, (byStep.get(v.step) || 0) + 1);
  for (const [step, n] of [...byStep].sort((a, b) => (a[0] < b[0] ? -1 : 1))) lines.push(`${n} × ${NEVER_WRITES[step] || plain(step, 40)}.`);
  const unplanned = m.verdicts.filter((v) => !v.step).length;
  if (unplanned) lines.push(`${unplanned} failure(s) have no plan (the plan step did not run).`);
  for (const h of m.heals) if (h.outcome !== 'kept') lines.push(`Self-heal on ${plain(h.branch, 80)}: ${h.outcome}${h.outcome === 'never ended' ? ' (the branch may still exist)' : ''}.`);
  return lines;
}

function renderMarkdown(m) {
  const out = [];
  const cell = (s) => plain(s);
  out.push(`## QA run ${cell(m.runId)}: ${m.outcome}`, '');
  const t = m.totals;
  const rows = [
    ['Framework', m.framework ? cell(m.framework) : 'not recorded'],
    ['Ticket', m.ticket ? cell(m.ticket) : 'none'],
    ['Started', m.started ? cell(m.started) : 'not recorded'],
    ['Finished', m.finished ? `${cell(m.ended)} (exit ${num(m.exit)}${m.complete ? ', complete' : ', not complete'})` : 'no'],
    ['Duration', duration(m.durationMs)],
    ['Tests', `${num(t.total)} total, ${num(t.passed)} passed, ${num(t.failed)} failed${t.skipped ? `, ${num(t.skipped)} skipped` : ''}${t.flaky ? `, ${num(t.flaky)} flaky` : ''}`],
    ['Runs the verdicts rest on', m.runs ? `${m.runs} (the main run${m.runs > 1 ? ` and ${m.runs - 1} re-run${m.runs > 2 ? 's' : ''}` : ''})` : 'none recorded'],
    ['Spent', spendLine(m.spent)],
  ];
  out.push('| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`), '');

  if (m.verdicts.length) {
    out.push(`### Failures (${m.verdicts.length})`, '', '| Test | Class | Confidence | Rule | What happened |', '|---|---|---|---|---|');
    for (const v of m.verdicts.slice(0, MAX_ROWS)) out.push(`| ${cell(v.test || v.token)} | ${cell(v.class)} | ${pct(v.confidence)} ${v.action === 'act' ? '(acted on)' : '(proposed)'} | ${cell(v.rule || '')} | ${v.outcome.text} |`);
    if (m.verdicts.length > MAX_ROWS) out.push('', `…and ${m.verdicts.length - MAX_ROWS} more failure(s) not listed.`);
    out.push('');
  }
  if (m.flaky.length) {
    out.push('### Flaky in this run, and how often over recent runs', '');
    for (const f of m.flaky.slice(0, MAX_LINES)) out.push(`- ${cell(f.name)}: flipped in ${f.flips} of its last ${f.runsSeen} run(s) (${pct(f.rate)})`);
    out.push('');
  }
  if (m.warnings.length) {
    out.push(`### Warnings (${m.warnings.length})`, '');
    for (const w of m.warnings.slice(0, MAX_LINES)) out.push(`- ${plain(w, 400)}`);
    if (m.warnings.length > MAX_LINES) out.push(`- …and ${m.warnings.length - MAX_LINES} more.`);
    out.push('');
  }
  const nd = notDone(m);
  out.push('### Not done, and why', '', ...(nd.length ? nd.map((l) => `- ${l}`) : ['- Nothing: every step ran and nothing is waiting.']), '');
  const text = out.join('\n');
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS)}\n\n(cut: the summary was longer than ${SUMMARY_MAX_CHARS} characters)\n` : text;
}

// Slack has no tables: a headline, the numbers, one line per failure, the warnings. Nothing in it can become a mention, a channel ping or a link (see slackSafe).
function renderSlack(m, { max = 3000 } = {}) {
  const t = m.totals;
  const lines = [`*QA run ${plain(m.runId)}: ${m.outcome}*`, `${num(t.total)} tests, ${num(t.passed)} passed, ${num(t.failed)} failed · ${duration(m.durationMs)} · ${spendLine(m.spent)}`];
  for (const v of m.verdicts.slice(0, 15)) lines.push(`• ${plain(v.test || v.token, 100)} (${plain(v.class, 30)}, ${pct(v.confidence)}): ${v.outcome.text}`);
  if (m.verdicts.length > 15) lines.push(`…and ${m.verdicts.length - 15} more failure(s).`);
  for (const w of m.warnings.slice(0, 5)) lines.push(`warning: ${plain(w, 200)}`);
  if (m.warnings.length > 5) lines.push(`…and ${m.warnings.length - 5} more warning(s).`);
  const text = lines.join('\n');
  return slackSafe(text.length > max ? `${text.slice(0, max - 1)}…` : text);
}

module.exports = { summarize, renderMarkdown, renderSlack, slackSafe, plain, duration, writesFor, MAX_ROWS };

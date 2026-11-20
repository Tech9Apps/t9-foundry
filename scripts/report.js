#!/usr/bin/env node
'use strict';

// A summary of one run, rendered from the run ledger (docs/phase-3-design.md, "Reporting"): what ran, what failed and why, what was done about it, and what was
// NOT done and why. Deterministic text from events, never model-written, so it reads the same for a pass, a failure and a run that was killed.
//
//   node scripts/report.js --run-id ID [--dir D] [--config P] [--window N] [--ticket T] [--comment-out FILE] [--no-slack] [--slack-only-failures] [--no-step-summary]
//
// Output: the summary, as Markdown, on stdout. Besides:
//   $GITHUB_STEP_SUMMARY   appended to, when set (and only if it names an existing regular file: this script does not create or follow anything there)
//   --comment-out FILE     a ticket-comment INPUT file in the shape plan.js writes ({ id, body, idempotencyKey }); posting it stays behind the existing gate
//                          (`node scripts/tracker/cli.js comment --input-file FILE`, on a person's yes). Needs a ticket: the run's own (--ticket on the orchestrator) or --ticket here
//   QA_SLACK_WEBHOOK       when set, one POST of a short version to that webhook (https, hooks.slack.com or a host in report.slackHosts, no redirects, size-capped).
//                          --slack-only-failures stays quiet on a green run; --no-slack never posts
// A problem with any of those three is a line on stderr ("report: ..."), never a failed report. Exit: 0 = done · 1 = no such run, or the ledger cannot be read
// (JSON { ok: false, error } on stdout) · 2 = bad invocation.
const fs = require('fs');
const crypto = require('crypto');
const { openLedger } = require('./ledger/lib/ledger');
const { ledgerConfig } = require('./ledger/lib/config');
const { flakeRates } = require('./ledger/lib/views');
const { summarize, renderMarkdown, renderSlack, plain } = require('./ledger/lib/summary');
const { slackTarget, postSlack } = require('./ledger/lib/slack');
const { reportConfig } = require('./ledger/lib/report-config');
const { usage, parseFlags, jsonPrinter, writeJson } = require('./lib/cli');
const { isValidRunId } = require('./lib/ids');

const FLAGS = {
  '--run-id': { key: 'runId' },
  '--dir': { key: 'dir' },
  '--config': { key: 'config' },
  '--ticket': { key: 'ticket' },
  '--comment-out': { key: 'commentOut' },
  '--window': { key: 'window', parse: (v, flag) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 1000) throw usage(`${flag} must be a whole number from 1 to 1000`); return n; } },
  '--no-slack': { key: 'noSlack', set: true },
  '--slack-only-failures': { key: 'slackOnlyFailures', set: true },
  '--no-step-summary': { key: 'noStepSummary', set: true },
};

// The file a run summary is appended to when $GITHUB_STEP_SUMMARY is set. The path comes from the environment, so it is not trusted: only an existing regular file
// (what the runner creates) is written, never a link, a folder or a path that does not exist yet.
function appendStepSummary(file, text) {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new Error('it is not an existing regular file');
  fs.appendFileSync(file, `${text}\n`);
}

async function main({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr, fetch = globalThis.fetch, now = Date.now } = {}) {
  const out = jsonPrinter(stdout);
  const warn = (m) => stderr.write(`report: ${m}\n`);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write('Usage: report.js --run-id ID [--dir D] [--config P] [--window N] [--ticket T] [--comment-out FILE] [--no-slack] [--slack-only-failures] [--no-step-summary]\n');
      return argv.length ? 0 : 2;
    }
    const opts = parseFlags(argv, FLAGS);
    if (opts.runId === undefined) throw usage('report needs --run-id');
    if (!isValidRunId(opts.runId)) throw usage('--run-id must be 1-128 characters with no control characters');
    if (opts.ticket !== undefined && !isValidRunId(opts.ticket)) throw usage('--ticket must be 1-128 characters with no control characters');
    const rc = reportConfig({ configPath: opts.config, env }); // a malformed block is refused before anything is read or sent
    const cfg = ledgerConfig({ configPath: opts.config, env });

    let ledger; let run; let auditEvents = [];
    const problems = [];
    try {
      ledger = openLedger({ dir: opts.dir || cfg.dir, now });
      run = ledger.readRun(opts.runId);
      if (run.events.length) {
        const a = ledger.readAudit();
        auditEvents = a.events.filter((e) => /^action\./.test(e.type));
        problems.push(...a.warnings);
      }
    } catch (err) {
      out({ ok: false, error: { code: err.code || 'UNEXPECTED', message: err.message } });
      return 1;
    }
    problems.push(...run.warnings);
    if (!run.events.length) {
      out({ ok: false, error: { code: 'RUN_NOT_FOUND', message: `there is no record of run ${plain(opts.runId, 80)} in the ledger${run.warnings.length ? ` (${run.warnings.join('; ')})` : ''}: a run is only recorded when the project has a \`ledger\` block in qa-config.json (or --ledger-dir was given), and a run that was refused leaves nothing` } });
      return 1;
    }

    let flake = [];
    try { flake = flakeRates(ledger, { window: opts.window }).tests; } catch (e) { problems.push(`the cross-run flake rates could not be read (${e.message})`); }
    const model = summarize({ runId: opts.runId, events: run.events, audit: auditEvents, flake });
    const markdown = renderMarkdown(model);
    stdout.write(`${markdown}\n`);
    for (const p of problems.slice(0, 10)) warn(`ledger: ${p}`);

    if (env.GITHUB_STEP_SUMMARY && !opts.noStepSummary) {
      try { appendStepSummary(env.GITHUB_STEP_SUMMARY, markdown); } catch (e) { warn(`the step summary was not written (${e.message})`); }
    }

    if (opts.commentOut) {
      const ticket = opts.ticket !== undefined ? opts.ticket : model.ticket;
      if (!ticket) warn('no comment file was written: this run has no ticket (pass --ticket, or give --ticket to the orchestrator)');
      else {
        try {
          const key = `report-${crypto.createHash('sha256').update(opts.runId).digest('hex').slice(0, 16)}`; // one comment per run however often this is run
          writeJson(opts.commentOut, { id: ticket, body: `${markdown}\n\nqa-harness-run-report: ${plain(opts.runId, 128)}`, idempotencyKey: key });
        } catch (e) { warn(`the comment file was not written (${e.message})`); }
      }
    }

    if (!opts.noSlack) {
      const t = slackTarget(env.QA_SLACK_WEBHOOK, { hosts: rc.slackHosts });
      if (t.configured && !t.ok) warn(`not posted to Slack: ${t.reason}`);
      else if (t.configured && t.ok && !(opts.slackOnlyFailures && model.green)) {
        const r = await postSlack({ url: t.url, text: renderSlack(model), fetch });
        if (!r.ok) warn(`not posted to Slack: ${r.reason}`);
      }
    }
    return 0;
  } catch (err) {
    if (err && err.isUsage) { stderr.write(`report: ${err.message}\n`); return 2; }
    out({ ok: false, error: { code: err.code || 'UNEXPECTED', message: err.message } });
    return 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { main, FLAGS };

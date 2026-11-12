'use strict';

const { unreadable, readJson } = require('../../lib/cli');

// The two documents the triage scripts hand to each other. run.js / normalize.js / orchestrate.js write them wrapped as { ok, data };
// either form is accepted. A file of the wrong kind is refused here, by name, instead of failing somewhere later.

// A triage report (classify.js output): { verdicts: [...] }.
function readReport(file) {
  const report = readJson(file, { unwrap: true });
  if (!report || !Array.isArray(report.verdicts)) throw unreadable(`${file} is not a triage report (no "verdicts" array)`);
  return report;
}

// A normalized run result (run.js / normalize.js output): { tests: [...] }.
function readRunResult(file) {
  const run = readJson(file, { unwrap: true });
  if (!run || !Array.isArray(run.tests)) throw unreadable(`${file} is not a normalized run result (no "tests" array)`);
  return run;
}

module.exports = { readReport, readRunResult };

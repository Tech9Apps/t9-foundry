'use strict';
// SEEDED SCENARIO: flaky. Fails on its first attempt and passes on every later one — a timing problem that has
// nothing to do with the app. State lives in $QA_SCENARIO_STATE so the first run and its re-runs share it.
// Expected triage: flaky (FLK-1), never filed as a bug.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('DEMO-102/TC-902: the order confirmation banner is shown', () => {
  const dir = process.env.QA_SCENARIO_STATE;
  if (!dir) throw new Error('set QA_SCENARIO_STATE to a scratch directory so attempts can be counted');
  const counter = path.join(dir, 'attempts');
  const attempt = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(counter, String(attempt));
  assert.ok(attempt > 1, 'banner was not visible yet on the first attempt');
});

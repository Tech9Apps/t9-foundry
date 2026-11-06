'use strict';

// The triage tests must not depend on whatever qa-config.json happens to sit in the developer's working directory.
//
// Review found they did: with `triage.confidenceThreshold: 0.95` in a repo-root qa-config.json, the classifier tests failed, because the
// classify CLI (like heal.js and the orchestrator) DISCOVERS ./qa-config.json when it is not told which config to use. Anyone who adopted
// the new setting would have seen a red suite for no reason of their own.
//
// This test is the guard against that happening again, in any test, not just the two that were found: it re-runs the triage test files in a
// directory that holds an aggressively hostile config (one re-run, a 0.95 threshold, no trusted format, self-heal switched ON), with
// CLAUDE_PROJECT_DIR pointing at it too. A test that reads a developer's config fails here, loudly, on every machine.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOSTILE = {
  project: { name: "a developer's own config, not the test's" },
  triage: { reruns: 1, confidenceThreshold: 0.95, trustedFormats: [], selfHeal: { enabled: true } },
};

// every file that exercises code which can read qa-config.json (heal's slow end-to-end block is skipped by name: it passes --config throughout)
const RUNS = [
  ['classify.test.js'], ['plan.test.js'], ['orchestrate.test.js'], ['locators.test.js'], ['fingerprint.test.js'], ['text.test.js'],
  ['realworld.test.js'], ['scenarios.test.js'], ['config.test.js'], ['heal.test.js', '--test-name-pattern=heal CLI'],
];

test('the triage tests give the same results when a hostile qa-config.json is in the working directory', { timeout: 600000 }, () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-hostile-'));
  fs.writeFileSync(path.join(dir, 'qa-config.json'), JSON.stringify(HOSTILE));
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
  delete env.NODE_TEST_CONTEXT; // a nested `node --test` must run its own tests, not be mistaken for part of this run
  const failures = [];
  for (const [file, ...extra] of RUNS) {
    const r = spawnSync(process.execPath, ['--test', ...extra, path.join(__dirname, file)], { cwd: dir, env, encoding: 'utf8' });
    if (r.status !== 0) failures.push(`${file}:\n    ${r.stdout.split('\n').filter((l) => /^\s*not ok/.test(l)).join('\n    ') || r.stderr.slice(0, 300)}`);
  }
  assert.deepEqual(failures, [], `these test files changed their result because of a qa-config.json in the working directory:\n${failures.join('\n')}`);
});

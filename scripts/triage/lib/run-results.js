'use strict';

// The default way to run a suite for triage: the real results runner, in this process, output captured. Shared by the
// orchestrator and by self-heal's validation re-run, so both run tests exactly the same way.
const { main: runResultsMain, killActive } = require('../../results/run');

async function defaultRunResults(argv, env) {
  let out = '';
  const code = await runResultsMain({ argv, env, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
  let doc = null;
  try { doc = out ? JSON.parse(out) : null; } catch { /* usage errors print nothing */ }
  return { code, doc };
}

module.exports = { defaultRunResults, killActive };

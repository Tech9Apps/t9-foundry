'use strict';

// When is a run recorded? Only when the project asked: a `ledger` block in qa-config.json (even an empty one) or --ledger-dir, and never
// with --no-ledger. A project with neither behaves exactly as it did before the ledger existed. Shared by the orchestrator and heal.js, so the
// two cannot disagree about whether this run is being remembered.
const { openLedger } = require('./ledger');
const { ledgerConfig } = require('./config');
const { usage } = require('../../lib/cli');

// null when recording is off; otherwise { ledger, cfg }.
function enabledLedger({ configPath, env = process.env, ledgerDir, noLedger, now = Date.now }) {
  if (noLedger && ledgerDir !== undefined) throw usage('--ledger-dir and --no-ledger contradict each other; give one');
  if (noLedger) return null;
  const cfg = ledgerConfig({ configPath, env });
  if (ledgerDir === undefined && !cfg.present) return null;
  return { ledger: openLedger({ dir: ledgerDir !== undefined ? ledgerDir : cfg.dir, now }), cfg };
}

module.exports = { enabledLedger };

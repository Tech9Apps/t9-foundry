'use strict';

// When is a run recorded? Only when the project asked: a `ledger` block in qa-config.json (even an empty one) or --ledger-dir. A project with
// neither behaves exactly as it did before the ledger existed. Shared by the orchestrator and heal.js, so the two cannot disagree about whether this
// run is being remembered.
//
// A project that HAS a ledger block cannot be diverted from it by a flag: the heal attempt cap lives in that ledger, and a flag may tighten what the
// project set, never lift it (a different or no ledger would be an empty one, and the cap would see no attempts). There is deliberately no flag to
// turn the ledger off: take the block out of the config.
const { openLedger } = require('./ledger');
const { ledgerConfig } = require('./config');
const path = require('path');
const { usage } = require('../../lib/cli');

// null when recording is off; otherwise { ledger, cfg }.
function enabledLedger({ configPath, env = process.env, ledgerDir, now = Date.now }) {
  if (ledgerDir !== undefined && !(typeof ledgerDir === 'string' && ledgerDir.length && !/[\u0000-\u001f\u007f]/u.test(ledgerDir))) throw usage('--ledger-dir needs a folder path');
  const cfg = ledgerConfig({ configPath, env });
  if (cfg.present && ledgerDir !== undefined && path.resolve(ledgerDir) !== cfg.dir) {
    throw usage(`--ledger-dir ${JSON.stringify(ledgerDir.slice(0, 80))} is not the ledger ${cfg.file} names (${cfg.dir}): a flag may not move a project's ledger out from under the heal attempt cap it holds; change ledger.dir in the config instead`);
  }
  if (ledgerDir === undefined && !cfg.present) return null;
  return { ledger: openLedger({ dir: ledgerDir !== undefined ? ledgerDir : cfg.dir, now }), cfg };
}

module.exports = { enabledLedger };

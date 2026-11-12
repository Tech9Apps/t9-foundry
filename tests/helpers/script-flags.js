'use strict';
// The command-line flags a script defines, read from the FLAGS table it exports (scripts/lib/cli.js parseFlags builds its parser from the
// same table), plus --help, which every script answers itself. A script with no table, or an empty one, is an error: a check that found
// nothing to compare against would pass on anything.
const path = require('path');

module.exports = function scriptFlags(root, file) {
  const { FLAGS } = require(path.join(root, file));
  const names = FLAGS && typeof FLAGS === 'object' ? Object.keys(FLAGS) : [];
  if (!names.length) throw new Error(`${file} does not export a non-empty FLAGS table, so its options cannot be checked`);
  return new Set([...names, '--help']);
};

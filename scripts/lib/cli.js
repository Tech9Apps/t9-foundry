'use strict';

const fs = require('fs');
const path = require('path');

// What every script's command line and JSON reading rest on. Each script used to carry its own copy of these, so a fix to one
// (a message, an edge case) quietly missed the others.

// A mistake in how the script was invoked. `main` turns it into "<script>: <message>" on stderr and exit 2.
const usage = (message) => Object.assign(new Error(message), { isUsage: true });

// An error carrying a machine-readable `code` (the scripts report it as error.code in their JSON output and callers branch on it).
const codedError = (code, message) => Object.assign(new Error(message), { code });

// A file the script was pointed at that cannot be used. Callers branch on `code` (it is not a usage error: the invocation was fine).
const unreadable = (message) => codedError('UNREADABLE', message);

// Reads and parses a JSON file. `fail` builds the error thrown when it cannot be read (default: UNREADABLE; a config file that is
// part of the invocation passes `usage`, a tracker config passes a TrackerError). `unwrap` returns the `data` of a { ok, data }
// document (run.js / normalize.js / orchestrate.js write that shape) and the document itself when it has none.
function readJson(file, { fail = unreadable, unwrap = false } = {}) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw fail(`cannot read ${file}: ${e.message}`); }
  return unwrap && doc && doc.data ? doc.data : doc;
}

// What every script prints on stdout: one JSON document at a time.
const jsonPrinter = (stream) => (doc) => stream.write(`${JSON.stringify(doc, null, 2)}\n`);

// Writes a JSON document (indented, newline-terminated), creating the folders above it.
function writeJson(file, doc) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

// Parses argv against a table of flags:
//
//   '--source':     { key: 'source' }                         the next argument is the value
//   '--timeout-ms': { key: 'timeoutMs', parse: Number }       ...converted first: parse(value, flag)
//   '--dry-run':    { key: 'dryRun', set: true }              takes no value; sets the key to that constant
//                   (+ contradicts: 'message' makes a second flag that sets the same key to the opposite value a usage error)
//   '--spec':       { key: 'specs', list: true }              every occurrence is collected (the array is created on first use)
//
// `init` seeds the result (defaults, or a leading <op>); `positionals` collects bare words in `_` instead of refusing them. A flag
// that is not in the table is refused, and so is a flag with nothing after it. A value is whatever follows its flag, even if it
// starts with "-": the scripts have always taken it so, and a flag that must refuse that says so in its own `parse`.
// The table is also what the drift checks read to learn which flags a script defines, so a flag exists only if it is in here.
function parseFlags(argv, flags, { init = {}, positionals = false } = {}) {
  const opts = { ...init };
  if (positionals) opts._ = [];
  for (let n = 0; n < argv.length; n += 1) {
    const flag = argv[n];
    const spec = Object.hasOwn(flags, flag) ? flags[flag] : undefined;
    if (!spec) {
      if (positionals && !flag.startsWith('--')) { opts._.push(flag); continue; }
      throw usage(`unknown option ${flag}`);
    }
    if ('set' in spec) {
      // two flags that set one key to opposite values (--heal / --no-heal) are a mistake, not a preference: the last one used to win silently
      if (spec.contradicts && opts[spec.key] !== undefined && opts[spec.key] !== spec.set) throw usage(spec.contradicts);
      opts[spec.key] = spec.set;
      continue;
    }
    if (n + 1 >= argv.length) throw usage(`${flag} needs a value`);
    n += 1;
    const value = spec.parse ? spec.parse(argv[n], flag) : argv[n];
    if (spec.list) opts[spec.key] = [...(opts[spec.key] || []), value];
    else opts[spec.key] = value;
  }
  return opts;
}

module.exports = { usage, codedError, unreadable, readJson, writeJson, jsonPrinter, parseFlags };

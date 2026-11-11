#!/usr/bin/env node
'use strict';

// Tracker adapter CLI — the one way the harness's commands and agents talk to a ticket system.
//
//   node scripts/tracker/cli.js <op> [options]
//
//   ops:      fetch | search | create-test | link | comment | create-bug
//   input:    --input '<json>'  |  --input-file <path>  |  --stdin (read JSON from stdin)
//   options:  --context-file <path> (fetch only) also write the pipeline's ticket-context JSON there
//             --source <type>      github | clickup | azure   (default: ticketSource.type from the config)
//             --config <path>      qa-config.json (default: $CLAUDE_PROJECT_DIR/qa-config.json, ./, ../, ../../)
//             --base-url <url>     override the API base URL (mock servers; also $QA_TRACKER_BASE_URL)
//             --timeout-ms <n>     per-request timeout (default 15000)
//
// Output is always one JSON document on stdout:
//   { "ok": true,  "data": { ... } }
//   { "ok": false, "error": { "code", "message", "retriable", ... } }
// Exit codes: 0 success · 1 the operation failed (see error.code) · 2 bad invocation.
// Secrets are read from environment variables only and are never printed.

const fs = require('fs');
const path = require('path');
const { OPERATIONS } = require('./lib/contract');
const { TrackerError } = require('./lib/errors');
const { run } = require('./adapters');
const { connect } = require('./lib/connect');
const { toTicketContext } = require('./lib/context');

function parseArgs(argv) {
  const [op, ...rest] = argv;
  const opts = { op };
  for (let n = 0; n < rest.length; n += 1) {
    const flag = rest[n];
    const value = () => {
      if (n + 1 >= rest.length) throw usage(`${flag} needs a value`);
      n += 1;
      return rest[n];
    };
    if (flag === '--source') opts.source = value();
    else if (flag === '--config') opts.config = value();
    else if (flag === '--input') opts.input = value();
    else if (flag === '--input-file') opts.inputFile = value();
    else if (flag === '--stdin') opts.stdin = true;
    else if (flag === '--context-file') opts.contextFile = value();
    else if (flag === '--base-url') opts.baseUrl = value();
    else if (flag === '--timeout-ms') opts.timeoutMs = Number(value());
    else throw usage(`unknown option ${flag}`);
  }
  return opts;
}

const usage = (message) => Object.assign(new Error(message), { isUsage: true });

async function readStdin(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main({ argv = process.argv.slice(2), env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, fetch = globalThis.fetch } = {}) {
  const out = (obj) => stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write(`Usage: cli.js <${OPERATIONS.join('|')}> [--source T] [--config P] [--input J | --input-file P | --stdin] [--base-url U] [--timeout-ms N] [--context-file P]\n`);
      return argv.length ? 0 : 2;
    }
    const opts = parseArgs(argv);
    if (!OPERATIONS.includes(opts.op)) throw usage(`unknown operation "${opts.op}" (expected one of ${OPERATIONS.join(', ')})`);
    if (opts.contextFile && opts.op !== 'fetch') throw usage('--context-file only applies to fetch');

    // Input
    let raw = opts.input;
    if (raw === undefined && opts.inputFile) raw = fs.readFileSync(opts.inputFile, 'utf8');
    // stdin is opt-in: an inherited-but-never-closed pipe would otherwise hang an unattended run.
    if (raw === undefined && opts.stdin) raw = await readStdin(stdin);
    if (raw === undefined) throw usage('no input: pass --input, --input-file or --stdin');
    let input = {};
    if (raw && raw.trim()) {
      try { input = JSON.parse(raw); } catch (e) { throw usage(`input is not valid JSON (${e.message})`); }
    }

    const adapter = connect({ configPath: opts.config, source: opts.source, baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs, env, fetch });
    const data = await run(adapter, opts.op, input);
    if (opts.contextFile) {
      fs.mkdirSync(path.dirname(path.resolve(opts.contextFile)), { recursive: true });
      fs.writeFileSync(opts.contextFile, `${JSON.stringify(toTicketContext(data), null, 2)}\n`);
    }
    out({ ok: true, data });
    return 0;
  } catch (err) {
    if (err && err.isUsage) {
      stderr.write(`cli.js: ${err.message}\n`);
      return 2;
    }
    if (err instanceof TrackerError) {
      out({ ok: false, error: err.toJSON() });
      return 1;
    }
    out({ ok: false, error: { code: 'UPSTREAM_ERROR', message: `unexpected error: ${err && err.message}`, retriable: false } });
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { main };

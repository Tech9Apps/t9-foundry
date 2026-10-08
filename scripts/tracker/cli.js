#!/usr/bin/env node
'use strict';

// Tracker adapter CLI — the one way the harness's commands and agents talk to a ticket system.
//
//   node scripts/tracker/cli.js <op> [options]
//
//   ops:      fetch | search | create-test | link | comment | create-bug
//   input:    --input '<json>'  |  --input-file <path>  |  --stdin (read JSON from stdin)
//   options:  --source <type>      github | clickup | azure   (default: ticketSource.type from the config)
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
const { createAdapter, run, SUPPORTED } = require('./adapters');

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
    else if (flag === '--base-url') opts.baseUrl = value();
    else if (flag === '--timeout-ms') opts.timeoutMs = Number(value());
    else throw usage(`unknown option ${flag}`);
  }
  return opts;
}

const usage = (message) => Object.assign(new Error(message), { isUsage: true });

function findConfig(explicit, env) {
  if (explicit) return explicit;
  const candidates = [];
  if (env.CLAUDE_PROJECT_DIR) candidates.push(path.join(env.CLAUDE_PROJECT_DIR, 'qa-config.json'));
  candidates.push('qa-config.json', '../qa-config.json', '../../qa-config.json');
  return candidates.find((c) => fs.existsSync(c));
}

async function readStdin(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main({ argv = process.argv.slice(2), env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, fetch = globalThis.fetch } = {}) {
  const out = (obj) => stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write(`Usage: cli.js <${OPERATIONS.join('|')}> [--source T] [--config P] [--input J | --input-file P | --stdin] [--base-url U] [--timeout-ms N]\n`);
      return argv.length ? 0 : 2;
    }
    const opts = parseArgs(argv);
    if (!OPERATIONS.includes(opts.op)) throw usage(`unknown operation "${opts.op}" (expected one of ${OPERATIONS.join(', ')})`);

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

    // Config
    const configPath = findConfig(opts.config, env);
    let config = {};
    if (configPath) {
      try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { throw new TrackerError('CONFIG', `cannot read ${configPath}: ${e.message}`); }
    } else if (!opts.source) {
      throw new TrackerError('CONFIG', 'no qa-config.json found and no --source given — run /init or pass --config');
    }
    const type = opts.source || (config.ticketSource && config.ticketSource.type);
    if (!type || type === 'none') {
      throw new TrackerError('CONFIG', `ticketSource.type is "${type || 'unset'}" — there is no tracker to talk to (supported: ${SUPPORTED.join(', ')})`);
    }

    const adapter = createAdapter(type, {
      settings: (config.ticketSource && config.ticketSource[type]) || {},
      env,
      fetch,
      baseUrl: opts.baseUrl || env.QA_TRACKER_BASE_URL || undefined,
      timeoutMs: opts.timeoutMs || undefined,
    });
    out({ ok: true, data: await run(adapter, opts.op, input) });
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

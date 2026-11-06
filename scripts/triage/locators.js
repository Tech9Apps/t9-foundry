#!/usr/bin/env node
'use strict';

// Evidence for rule TST-1 ("stale selector"): the test could not find an element by test-id. Is that id on the
// page at all, and if not, which element looks like what it meant? Deterministic, over an HTML snapshot — the
// orchestrator captures the page; this reads it.
//
//   node scripts/triage/locators.js --html page.html --selector "getByTestId('add-to-cart')"   (or the error message)
//   node scripts/triage/locators.js --html page.html --report triage.json --token qafp0123456789ab [--evidence-out evidence.json]
//
// The second form is the one an agent uses: it passes only a fingerprint token (one alphanumeric word), and this script finds the failing
// verdict in the report and reads its error text itself — so nothing that came out of a failing test (a title, a message with quotes or a
// "$(...)") is ever put on a command line. --evidence-out merges { "<test key>": { "locator": <data> } } into that file, which is the
// evidence file classify.js reads, so nobody has to assemble JSON by hand.
//
// Output: { ok: true, data: { target, present, candidates: [{ testid, similarity, tag, text }] } } — exactly the
// `locator` object classify.js reads from --evidence. Exit 0 = analysed, 1 = unreadable / no test-id in the selector, 2 = usage.

const fs = require('fs');
const path = require('path');
const { extractTestId, evidenceText } = require('./lib/text');

const SYNONYMS = { btn: 'button', qty: 'quantity', cta: 'button', img: 'image', nav: 'navigation', msg: 'message', num: 'number', amt: 'amount', info: 'information' };
// Strictly more than half: two ids that share ONE word out of two (cart-count / cart-total, Dice 0.5) are different elements, and a removed
// feature next to a similarly named one must not read as a rename. A real rename shares most of its words (add-to-cart / add-to-basket 0.67).
const THRESHOLD = 0.6;
const usage = (message) => Object.assign(new Error(message), { isUsage: true });

const tokens = (id) => String(id).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const canon = (t) => SYNONYMS[t] || t;
// two tokens match if equal after synonyms, or one is a prefix of the other (qty/quantity, nav/navigation)
const same = (a, b) => canon(a) === canon(b) || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));

function similarity(a, b) {
  const ta = tokens(a); const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const used = new Set();
  let hit = 0;
  for (const x of ta) {
    const j = tb.findIndex((y, i) => !used.has(i) && same(x, y));
    if (j >= 0) { used.add(j); hit += 1; }
  }
  return Math.round(((2 * hit) / (ta.length + tb.length)) * 100) / 100; // Dice coefficient
}

function testIdsIn(html) {
  const out = [];
  const re = /<([a-zA-Z][\w-]*)\b([^>]*?)\bdata-(?:testid|test-id|cy|qa)\s*=\s*(?:"([^"]*)"|'([^']*)')([^>]*)>([^<]*)/g;
  for (const m of String(html).matchAll(re)) out.push({ testid: m[3] !== undefined ? m[3] : m[4], tag: m[1].toLowerCase(), text: m[6].replace(/\s+/g, ' ').trim().slice(0, 60) });
  return out;
}

// bare: a lone word is accepted as the test-id itself (--selector add-to-cart). That is for a person typing a selector — never for text read out of
// an error message, where a one-word message ("boom") would otherwise become a test-id called "boom".
function analyzeLocator({ html, selector, bare = true }) {
  const target = extractTestId(selector) || (bare && /^[\w-]+$/.test(String(selector).trim()) ? String(selector).trim() : null);
  if (!target) throw Object.assign(new Error(`no test-id found in "${String(selector).slice(0, 80)}" (looked for getByTestId('x'), [data-testid=x], data-cy=…)`), { code: 'NO_TESTID' });
  const elements = testIdsIn(html);
  const present = elements.some((e) => e.testid === target);
  const candidates = elements.filter((e) => e.testid !== target)
    .map((e) => ({ ...e, similarity: similarity(target, e.testid) }))
    .filter((e) => e.similarity >= THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity);
  return { target, present, candidates };
}

const TOKEN = /^qafp[0-9a-f]{12}$/;
const unreadable = (what, e) => Object.assign(new Error(`cannot read ${what}: ${e.message}`), { code: 'UNREADABLE' });

// the verdict a token names, and what its failure SAYS (message + the reporter's diagnosis) — which is where the test-id usually is
function verdictFor(reportFile, token) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch (e) { throw unreadable(reportFile, e); }
  const report = doc && doc.data ? doc.data : doc;
  if (!report || !Array.isArray(report.verdicts)) throw Object.assign(new Error(`${reportFile} is not a triage report (no "verdicts" array)`), { code: 'UNREADABLE' });
  const v = report.verdicts.find((x) => x.token === token);
  if (!v) throw Object.assign(new Error(`no verdict with token ${token} in ${reportFile}`), { code: 'UNKNOWN_TOKEN' });
  if (!v.error) throw Object.assign(new Error(`the verdict for ${token} records no error text to read a locator from`), { code: 'NO_ERROR' });
  return v;
}

// merge into the evidence file without ever clobbering one that cannot be read
function mergeEvidence(file, key, locator) {
  let evidence = {};
  if (fs.existsSync(file)) {
    try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw unreadable(file, e); }
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw Object.assign(new Error(`${file} is not an evidence object, so it was left alone`), { code: 'UNREADABLE' });
  }
  evidence[key] = { ...(evidence[key] || {}), locator };
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
}

function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  const out = (obj) => stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write('Usage: locators.js --html <page.html> (--selector <selector or error message> | --report <triage.json> --token <qafp…> [--evidence-out <evidence.json>])\n');
      return argv.length ? 0 : 2;
    }
    const opts = {};
    for (let n = 0; n < argv.length; n += 1) {
      const flag = argv[n];
      const value = () => { if (n + 1 >= argv.length) throw usage(`${flag} needs a value`); n += 1; return argv[n]; };
      if (flag === '--html') opts.html = value();
      else if (flag === '--selector') opts.selector = value();
      else if (flag === '--report') opts.report = value();
      else if (flag === '--token') opts.token = value();
      else if (flag === '--evidence-out') opts.evidenceOut = value();
      else throw usage(`unknown option ${flag}`);
    }
    const byToken = opts.report !== undefined || opts.token !== undefined;
    if (!opts.html) throw usage('--html is required');
    if (byToken && opts.selector !== undefined) throw usage('use --selector OR --report with --token, not both');
    if (byToken && !(opts.report && opts.token)) throw usage('--report and --token go together');
    if (!byToken && !opts.selector) throw usage('--selector (or --report with --token) is required');
    if (opts.evidenceOut && !byToken) throw usage('--evidence-out needs --report and --token (it files the result under that verdict\'s key)');
    if (byToken && !TOKEN.test(opts.token)) throw usage('--token must be a fingerprint token from the report (qafp followed by 12 hex digits)');
    let html;
    try { html = fs.readFileSync(opts.html, 'utf8'); } catch (e) { throw unreadable(opts.html, e); }
    if (!byToken) { out({ ok: true, data: analyzeLocator({ html, selector: opts.selector }) }); return 0; }
    const verdict = verdictFor(opts.report, opts.token);
    const data = analyzeLocator({ html, selector: evidenceText(verdict.error), bare: false });
    if (opts.evidenceOut) mergeEvidence(opts.evidenceOut, verdict.key, data);
    out({ ok: true, data, key: verdict.key, ...(opts.evidenceOut ? { evidenceFile: opts.evidenceOut } : {}) });
    return 0;
  } catch (err) {
    if (err && err.isUsage) { stderr.write(`locators.js: ${err.message}\n`); return 2; }
    out({ ok: false, error: { code: err.code || 'UNEXPECTED', message: err.message } });
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, analyzeLocator, similarity, verdictFor, mergeEvidence };

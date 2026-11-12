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
const { extractTestId, evidenceText } = require('./lib/text');
const { usage, unreadable, readJson, writeJson, parseFlags, jsonPrinter, codedError } = require('../lib/cli');
const { readReport } = require('./lib/documents');

const SYNONYMS = { btn: 'button', qty: 'quantity', cta: 'button', img: 'image', nav: 'navigation', msg: 'message', num: 'number', amt: 'amount', info: 'information' };
// Strictly more than half: two ids that share ONE word out of two (cart-count / cart-total, Dice 0.5) are different elements, and a removed
// feature next to a similarly named one must not read as a rename. A real rename shares most of its words (add-to-cart / add-to-basket 0.67).
const THRESHOLD = 0.6;

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

// The test ids on a page. A scanner, not a regex: a regex that looks for "<tag ... data-testid=..." mishandles what real markup does (an unquoted value, a
// ">" inside an earlier quoted attribute, upper-case names, a tag in a comment or a script) and "not on the page" is the claim that turns into a
// test-bug verdict, so it must never be said of an element that is. One pass, no backtracking, so a page of unterminated tags cannot make it slow.
const TEST_ATTR = /^data-(?:testid|test-id|test|cy|qa)$/i;
// A page bigger than this is refused (TOO_LARGE), not truncated: an element past a silent cut would read as "not on the page".
const MAX_HTML = 64 * 1024 * 1024;
const TAG_OPEN = /<([A-Za-z][A-Za-z0-9:-]*)/y;
const ATTR = /[\s/]*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
const TAG_END = /[\s/]*>/y;
const CLOSE_SCRIPT = /<\/script/gi; // searched from a given position, case-insensitively, without lower-casing the whole page each time
const CLOSE_STYLE = /<\/style/gi;
function testIdsIn(html) {
  const s = String(html);
  if (s.length > MAX_HTML) throw Object.assign(new Error(`the page is too large to scan (${s.length} characters, the limit is ${MAX_HTML}), so nothing can be said about what is on it`), { code: 'TOO_LARGE' });
  const out = [];
  let i = 0;
  while ((i = s.indexOf('<', i)) !== -1) {
    if (s.startsWith('<!--', i)) {
      // <!--> and <!---> are complete (empty) comments; otherwise the comment ends at --> or --!>, whichever comes first; an unterminated one swallows the rest
      if (s.startsWith('<!-->', i)) { i += 5; continue; }
      if (s.startsWith('<!--->', i)) { i += 6; continue; }
      const a = s.indexOf('-->', i + 4); const b = s.indexOf('--!>', i + 4);
      const end = a === -1 ? b : b === -1 ? a : Math.min(a, b);
      if (end === -1) break;
      i = end + (s.startsWith('--!>', end) ? 4 : 3);
      continue;
    }
    TAG_OPEN.lastIndex = i;
    const open = TAG_OPEN.exec(s);
    if (!open) { i += 1; continue; }
    const tag = open[1].toLowerCase();
    let pos = TAG_OPEN.lastIndex;
    const ids = [];
    const seen = new Set(); // a repeated attribute counts once (the first), as in a browser; different spellings are different attributes
    for (;;) { // attributes, up to the ">" that is OUTSIDE any quote
      TAG_END.lastIndex = pos;
      if (TAG_END.exec(s)) { pos = TAG_END.lastIndex; break; }
      ATTR.lastIndex = pos;
      const a = ATTR.exec(s);
      if (!a || ATTR.lastIndex === pos) break; // malformed (an unterminated quote, a stray character): give up on this tag
      pos = ATTR.lastIndex;
      const name = a[1].toLowerCase();
      if (TEST_ATTR.test(name) && !seen.has(name)) { seen.add(name); ids.push(a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4]); }
    }
    if (tag === 'script' || tag === 'style') { // raw text up to the closing tag: nothing in it is the page
      const closer = tag === 'script' ? CLOSE_SCRIPT : CLOSE_STYLE;
      closer.lastIndex = pos;
      const close = closer.exec(s);
      i = close ? close.index : s.length;
      continue;
    }
    if (ids.length) {
      const next = s.indexOf('<', pos);
      const text = s.slice(pos, next === -1 ? s.length : next).replace(/\s+/g, ' ').trim().slice(0, 60);
      for (const testid of ids) out.push({ testid, tag, text });
    }
    i = Math.max(pos, i + 1);
  }
  return out;
}

// bare: a lone word is accepted as the test-id itself (--selector add-to-cart). That is for a person typing a selector — never for text read out of
// an error message, where a one-word message ("boom") would otherwise become a test-id called "boom".
function analyzeLocator({ html, selector, bare = true }) {
  const target = extractTestId(selector) || (bare && /^[\w-]+$/.test(String(selector).trim()) ? String(selector).trim() : null);
  if (!target) throw codedError('NO_TESTID', `no test-id found in "${String(selector).slice(0, 80)}" (looked for getByTestId('x'), [data-testid=x], data-cy=…)`);
  const elements = testIdsIn(html);
  const present = elements.some((e) => e.testid === target);
  const candidates = elements.filter((e) => e.testid !== target)
    .map((e) => ({ ...e, similarity: similarity(target, e.testid) }))
    .filter((e) => e.similarity >= THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity);
  return { target, present, candidates };
}

const TOKEN = /^qafp[0-9a-f]{12}$/;

// the verdict a token names, and what its failure SAYS (message + the reporter's diagnosis) — which is where the test-id usually is
function verdictFor(reportFile, token) {
  const report = readReport(reportFile);
  const v = report.verdicts.find((x) => x.token === token);
  if (!v) throw codedError('UNKNOWN_TOKEN', `no verdict with token ${token} in ${reportFile}`);
  if (!v.error) throw codedError('NO_ERROR', `the verdict for ${token} records no error text to read a locator from`);
  return v;
}

// merge into the evidence file without ever clobbering one that cannot be read
function mergeEvidence(file, key, locator) {
  let evidence = {};
  if (fs.existsSync(file)) {
    evidence = readJson(file);
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw unreadable(`${file} is not an evidence object, so it was left alone`);
  }
  evidence[key] = { ...(evidence[key] || {}), locator };
  writeJson(file, evidence);
}

const FLAGS = {
  '--html': { key: 'html' },
  '--selector': { key: 'selector' },
  '--report': { key: 'report' },
  '--token': { key: 'token' },
  '--evidence-out': { key: 'evidenceOut' },
};

function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  const out = jsonPrinter(stdout);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write('Usage: locators.js --html <page.html> (--selector <selector or error message> | --report <triage.json> --token <qafp…> [--evidence-out <evidence.json>])\n');
      return argv.length ? 0 : 2;
    }
    const opts = parseFlags(argv, FLAGS);
    const byToken = opts.report !== undefined || opts.token !== undefined;
    if (!opts.html) throw usage('--html is required');
    if (byToken && opts.selector !== undefined) throw usage('use --selector OR --report with --token, not both');
    if (byToken && !(opts.report && opts.token)) throw usage('--report and --token go together');
    if (!byToken && !opts.selector) throw usage('--selector (or --report with --token) is required');
    if (opts.evidenceOut && !byToken) throw usage('--evidence-out needs --report and --token (it files the result under that verdict\'s key)');
    if (byToken && !TOKEN.test(opts.token)) throw usage('--token must be a fingerprint token from the report (qafp followed by 12 hex digits)');
    let html;
    try { html = fs.readFileSync(opts.html, 'utf8'); } catch (e) { throw unreadable(`cannot read ${opts.html}: ${e.message}`); }
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

module.exports = { main, analyzeLocator, similarity, verdictFor, mergeEvidence, FLAGS };

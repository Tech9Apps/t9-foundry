#!/usr/bin/env node
'use strict';

// Evidence for rule TST-1 ("stale selector"): the test could not find an element by test-id. Is that id on the
// page at all, and if not, which element looks like what it meant? Deterministic, over an HTML snapshot — the
// orchestrator captures the page; this reads it.
//
//   node scripts/triage/locators.js --html page.html --selector "getByTestId('add-to-cart')"   (or the error message)
//
// Output: { ok: true, data: { target, present, candidates: [{ testid, similarity, tag, text }] } } — exactly the
// `locator` object classify.js reads from --evidence. Exit 0 = analysed, 1 = unreadable / no test-id in the selector, 2 = usage.

const fs = require('fs');
const { extractTestId } = require('./lib/text');

const SYNONYMS = { btn: 'button', qty: 'quantity', cta: 'button', img: 'image', nav: 'navigation', msg: 'message', num: 'number', amt: 'amount', info: 'information' };
const THRESHOLD = 0.5;
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

function analyzeLocator({ html, selector }) {
  const target = extractTestId(selector) || (/^[\w-]+$/.test(String(selector).trim()) ? String(selector).trim() : null);
  if (!target) throw Object.assign(new Error(`no test-id found in "${String(selector).slice(0, 80)}" (looked for getByTestId('x'), [data-testid=x], data-cy=…)`), { code: 'NO_TESTID' });
  const elements = testIdsIn(html);
  const present = elements.some((e) => e.testid === target);
  const candidates = elements.filter((e) => e.testid !== target)
    .map((e) => ({ ...e, similarity: similarity(target, e.testid) }))
    .filter((e) => e.similarity >= THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity);
  return { target, present, candidates };
}

function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  const out = (obj) => stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
      stderr.write('Usage: locators.js --html <page.html> --selector <selector or error message>\n');
      return argv.length ? 0 : 2;
    }
    const opts = {};
    for (let n = 0; n < argv.length; n += 1) {
      const flag = argv[n];
      const value = () => { if (n + 1 >= argv.length) throw usage(`${flag} needs a value`); n += 1; return argv[n]; };
      if (flag === '--html') opts.html = value();
      else if (flag === '--selector') opts.selector = value();
      else throw usage(`unknown option ${flag}`);
    }
    if (!opts.html || !opts.selector) throw usage('--html and --selector are both required');
    let html;
    try { html = fs.readFileSync(opts.html, 'utf8'); } catch (e) { throw Object.assign(new Error(`cannot read ${opts.html}: ${e.message}`), { code: 'UNREADABLE' }); }
    out({ ok: true, data: analyzeLocator({ html, selector: opts.selector }) });
    return 0;
  } catch (err) {
    if (err && err.isUsage) { stderr.write(`locators.js: ${err.message}\n`); return 2; }
    out({ ok: false, error: { code: err.code || 'UNEXPECTED', message: err.message } });
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, analyzeLocator, similarity };

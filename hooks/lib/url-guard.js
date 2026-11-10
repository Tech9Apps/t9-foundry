#!/usr/bin/env node
'use strict';

// Reference implementation of the production-URL decision, shared by the shell hooks (prod-guard.sh, env-detector.sh).
// The runtime guards in templates/e2e/** (TypeScript, Python, Ruby) are ports of exactly this logic;
// tests/fixtures/guard-cases.json is run against all of them, so they cannot drift apart.
//
// decide(url, cfg) → { decision: 'allow' | 'warn' | 'block', reason, detail? }
//
//   1. a configured prodUrlPatterns regex matching ANY normalized form of the URL → block (both modes)
//   2. blockOnSuspiciousUrls === false → allow (patterns above still apply; enforce mode never overrides this opt-out)
//   3. a URL whose host cannot be verified (variables, escapes, odd characters, not http(s)) → block in enforce, warn otherwise
//   4. a known tracker/registry host, an allowedUrlPatterns match, or the configured test environment's own host → allow
//   5. a host that is recognizably NOT production (a staging/test/dev/qa/… LABEL, a reserved or private address) → allow
//   6. anything else is an unrecognized host: block in enforce (fail closed), warn otherwise
//
// What it deliberately is not: it reads URLs, not intent. A redirect from an allowed host, a hostname held in a variable,
// DNS that points a staging name at production, or a target given without a URL are outside what a static check can see.

const fs = require('fs');

const NONPROD_TOKENS = new Set(['staging', 'stage', 'stg', 'test', 'testing', 'dev', 'develop', 'development', 'qa', 'uat', 'sandbox', 'sbx', 'preprod', 'preview', 'integration']);
// NOT here: "local" and "localhost". Loopback is matched exactly (host === localhost, *.localhost, *.local) — as a mere label they would
// bless "localhost.evil.com".
const PROD_TOKENS = new Set(['prod', 'production', 'live', 'prd']);
const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost', 'local']);
const DOC_HOSTS = ['example.com', 'example.org', 'example.net'];
// Hosts the pipeline legitimately talks to. Exempt from the heuristic only — configured prodUrlPatterns always win.
const BUILTIN_EXEMPT_HOSTS = ['github.com', 'githubusercontent.com', 'gitlab.com', 'bitbucket.org', 'dev.azure.com', 'visualstudio.com', 'api.clickup.com', 'atlassian.net', 'atlassian.com',
  'registry.npmjs.org', 'npmjs.org', 'npmjs.com', 'registry.yarnpkg.com', 'pypi.org', 'pythonhosted.org', 'rubygems.org', 'nodejs.org'];

const onLabelBoundary = (host, domain) => host === domain || host.endsWith(`.${domain}`);

// ── parsing ────────────────────────────────────────────────────────────────────────────────────
// http(s) only. Returns null when it is not a URL we can reason about.
function parseUrl(url) {
  const m = /^(https?):\/\/([^/?#]*)([^?#]*)/i.exec(String(url));
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const authority = m[2];
  if (authority.includes('\\')) return null; // browsers and curl disagree about "\": do not guess
  const at = authority.lastIndexOf('@');
  const hostport = at >= 0 ? authority.slice(at + 1) : authority; // userinfo is never the host
  let host; let port = ''; let v6 = false;
  if (hostport.startsWith('[')) {
    const b = /^\[([^\]]*)\](?::(\d*))?$/.exec(hostport);
    if (!b) return null;
    host = b[1].toLowerCase(); port = b[2] || ''; v6 = true;
  } else {
    const b = /^([^:]*)(?::(\d*))?$/.exec(hostport);
    if (!b) return null;
    host = b[1].toLowerCase().replace(/\.+$/, ''); port = b[2] || ''; // "host." and "host" are the same host
  }
  if (!host) return null;
  const path = m[3] === '' ? '/' : m[3]; // query and fragment are not part of what a pattern may match
  const verifiable = v6 ? /^[0-9a-f:.]+$/.test(host) : /^[a-z0-9._-]+$/.test(host);
  return { scheme, host, port, v6, path, verifiable };
}

// inet_aton semantics: 1–4 parts, each decimal / 0x-hex / 0-octal, the last part fills the remaining bytes.
// "3405803783", "0xcb007107", "203.0.113.7" and "0313.0.0161.7" are all the same address.
function toIPv4(host) {
  if (!/^[0-9a-fx.]+$/i.test(host)) return null;
  const parts = host.split('.');
  if (parts.length > 4 || parts.some((p) => p === '')) return null;
  const nums = [];
  for (const p of parts) {
    if (/^0x[0-9a-f]+$/i.test(p)) nums.push(parseInt(p, 16));
    else if (/^0[0-7]+$/.test(p)) nums.push(parseInt(p, 8));
    else if (/^[0-9]+$/.test(p)) nums.push(parseInt(p, 10));
    else return null;
  }
  const last = nums[nums.length - 1];
  const room = 2 ** (8 * (5 - nums.length));
  if (nums.slice(0, -1).some((n) => n > 255) || last >= room) return null;
  let value = last;
  nums.slice(0, -1).forEach((n, i) => { value += n * 2 ** (8 * (3 - i)); });
  return [Math.floor(value / 2 ** 24) % 256, Math.floor(value / 2 ** 16) % 256, Math.floor(value / 256) % 256, value % 256].join('.');
}

const isPrivateV4 = (ip) => {
  const [a, b] = ip.split('.').map(Number);
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
};
function isPrivateV6(host) {
  if (host === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true; // unique-local, link-local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  return !!mapped && !!toIPv4(mapped[1]) && isPrivateV4(toIPv4(mapped[1]));
}

function nonProdHost(u) {
  if (u.v6) return isPrivateV6(u.host);
  const ip = toIPv4(u.host);
  if (ip) return isPrivateV4(ip);
  if (u.host === 'localhost' || u.host.endsWith('.localhost')) return true;
  const labels = u.host.split('.');
  if (labels.length > 1 && RESERVED_TLDS.has(labels[labels.length - 1])) return true;
  if (DOC_HOSTS.some((d) => onLabelBoundary(u.host, d))) return true;
  // Tokens come from the host's labels WITHOUT its TLD (".dev" is a real TLD, not a staging marker), split on . - _ and compared
  // whole: "devices" and "aqua" and "attestation" are not "dev", "qa" and "test".
  const tokens = labels.slice(0, -1).join('.').split(/[._-]/).filter(Boolean);
  if (tokens.some((t) => PROD_TOKENS.has(t))) return false; // "test-prod.acme.com" is production wearing a hat
  return tokens.some((t) => NONPROD_TOKENS.has(t));
}

// Every form of the URL a production pattern may reasonably be written against: as typed, without userinfo/query/fragment, with and
// without the port, host alone, and — for numeric hosts — the dotted-quad spelling of the same address.
function candidates(url, u) {
  const out = new Set([String(url)]);
  const hosts = [u.host];
  const ip = u.v6 ? null : toIPv4(u.host);
  if (ip && ip !== u.host) hosts.push(ip);
  for (const h of hosts) {
    const hs = u.v6 ? `[${h}]` : h;
    out.add(`${u.scheme}://${hs}${u.path}`); out.add(hs);
    if (u.port) { out.add(`${u.scheme}://${hs}:${u.port}${u.path}`); out.add(`${hs}:${u.port}`); }
  }
  return [...out];
}

const compile = (p, flags) => { try { return new RegExp(p, flags); } catch { return null; } };
// Does `re` first match INSIDE "scheme://host[:port]", the first `end` characters of `form`? (A match that begins at the first character of the path is not inside it.)
const startsAtHost = (re, form, end) => { const m = re.exec(form); return !!m && m.index < end; };

// A configured production pattern matching any normalized form of the URL (and any extra spelling given), or null.
function prodPatternHit(url, cfg, extraForms = []) {
  const u = parseUrl(url);
  const forms = [...(u && u.verifiable ? candidates(url, u) : [String(url)]), ...extraForms];
  for (const pattern of cfg.prodUrlPatterns || []) {
    const re = pattern ? compile(pattern, 'i') : null; // case-insensitive: hosts are
    if (re && forms.some((f) => re.test(f))) return { decision: 'block', reason: 'PROD_PATTERN', detail: pattern };
  }
  return null;
}

// ── the decision ───────────────────────────────────────────────────────────────────────────────
function decide(url, cfg = {}) {
  const enforce = cfg.mode === 'enforce';
  const failing = (reason, detail) => ({ decision: enforce ? 'block' : 'warn', reason, ...(detail ? { detail } : {}) });
  const u = parseUrl(url);

  // 1. configured production patterns win over everything, in both modes, even for a URL we could not otherwise parse
  const hit = prodPatternHit(url, cfg);
  if (hit) return hit;

  // 2. the heuristic can be switched off, explicitly: enforce mode never overrides that opt-out (patterns above still apply)
  if (cfg.blockOnSuspiciousUrls === false) return { decision: 'allow', reason: 'HEURISTIC_DISABLED' };

  // 3. a host we cannot verify statically is not one we can call safe
  if (!u) return failing('UNPARSEABLE', 'not an http(s) URL with a plain host');
  if (!u.verifiable) return failing('UNVERIFIABLE_HOST', 'the host contains a variable, escape, or non-plain character');

  // 4. known-good
  if (BUILTIN_EXEMPT_HOSTS.some((d) => onLabelBoundary(u.host, d))) return { decision: 'allow', reason: 'EXEMPT_HOST' };
  const authority = `${u.scheme}://${u.v6 ? `[${u.host}]` : u.host}${u.port ? `:${u.port}` : ''}`;
  const stripped = `${authority}${u.path}`; // no userinfo, query or fragment
  const plainAuthority = `${u.scheme}://${u.host}`;
  // An allow pattern has to START matching within "scheme://host[:port]". It may go on into the path ("://partner\\.io/guide" allows what is under /guide), but
  // text that merely appears later, inside the path of some other host ("https://evil.com/go/https://partner.io/guide"), allows nothing.
  for (const pattern of cfg.allowedUrlPatterns || []) {
    const re = pattern ? compile(pattern) : null; // an invalid allow-pattern never exempts anything
    if (re && (startsAtHost(re, stripped, authority.length) || startsAtHost(re, `${plainAuthority}${u.path}`, plainAuthority.length))) return { decision: 'allow', reason: 'ALLOWED_PATTERN', detail: pattern };
  }
  const testEnv = cfg.testEnvironmentBaseUrl ? parseUrl(cfg.testEnvironmentBaseUrl) : null;
  if (testEnv && testEnv.verifiable && testEnv.host === u.host) return { decision: 'allow', reason: 'TEST_ENV_HOST' };

  // 5. recognizably not production
  if (nonProdHost(u)) return { decision: 'allow', reason: 'NONPROD_HOST' };

  // 6. unrecognized: fail closed when nobody is watching
  return failing('UNRECOGNIZED_HOST');
}

// ── finding URLs in text ───────────────────────────────────────────────────────────────────────
const extractUrls = (text) => [...new Set((String(text).match(/https?:\/\/[^\s'"`<>)]+/gi) || []))];

// Everything in the text that curl, a browser or a library would read as a URL, however it is spelled. Each is judged one of two ways:
//   'full'     decide(): production patterns, then the "is this recognizably a test environment?" rules. For anything that is plainly an
//              http(s) URL: "https://host", "https:/host", "http:///host", "https:host", "//host", and a spelling with a backslash (which
//              decide() refuses to guess at: unverifiable).
//   'patterns' production patterns only. For a scheme that is not http(s) ("ftp://host", "sftp://user@host", "postgresql://host") and for
//              a bare "host/path" or "user@host": a bare token cannot be told from a file name ("out.json", "app.config.js"), so judging it
//              as an unrecognized host would block ordinary commands. A production host that is configured is still caught.
const TAIL = '[^\\s\'"`<>)]';
const HOSTISH = /^(?:[^/?#@]*@)?(?:\[|localhost\b|[^/?#]*\.|[^/?#]*:\d)/i; // has a dot, a port, brackets, or is localhost: not a bare word
function findUrls(text) {
  const s = String(text);
  const found = new Map(); // raw spelling -> { raw, url, mode }
  const add = (raw, url, mode) => { const had = found.get(raw); if (!had || (had.mode === 'patterns' && mode === 'full')) found.set(raw, { raw, url, mode }); };

  // ("http:///host" starts like the normal spelling but has three slashes: it is read below, with the other odd ones)
  for (const raw of extractUrls(s)) if (!/^https?:\/\/\//i.test(raw)) add(raw, raw, 'full');

  // http(s) with the slashes wrong: "https:/host", "https:///host", "https:host", "https:\\host"
  for (const m of s.matchAll(new RegExp(`\\b(https?):([/\\\\]*)(${TAIL}*)`, 'gi'))) {
    const [raw, scheme, slashes, rest] = m;
    if (!rest) continue;
    if (slashes.includes('\\')) { add(raw, raw, 'full'); continue; } // decide() will call it unverifiable
    if (slashes === '' && !(/^[A-Za-z0-9[%_-]/.test(rest) && HOSTISH.test(rest))) continue; // "https: for details" is prose
    add(raw, `${scheme.toLowerCase()}://${rest}`, 'full');
  }

  // any other scheme://host: production patterns only
  for (const m of s.matchAll(new RegExp(`\\b([a-z][a-z0-9+.-]*)://(${TAIL}+)`, 'gi'))) {
    if (/^https?$/i.test(m[1])) continue;
    add(m[0], `https://${m[2]}`, 'patterns');
  }

  // protocol-relative "//host/path" (as in "--url=//host", fetch("//host/api")): the host must look like one, so "ls //tmp/x" is left alone
  for (const m of s.matchAll(new RegExp(`(^|[\\s'"\`=(,;|&<>])(//[A-Za-z0-9[%_-]${TAIL}*)`, 'g'))) {
    if (HOSTISH.test(m[2].slice(2))) add(m[2], `https:${m[2]}`, 'full');
  }

  // a bare "host/path" or "user@host": production patterns only (see above)
  for (const m of s.matchAll(new RegExp(`(?:^|[\\s'"\`=(,;|&<>])((?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9-]+\\.)+[A-Za-z]{2,}\\.?(?::\\d{1,5})?(?:[/?#]${TAIL}*)?)(?=$|[\\s'"\`)<>,;|&])`, 'g'))) {
    add(m[1], `https://${m[1]}`, 'patterns');
  }
  return [...found.values()];
}

function scan(text, cfg) {
  const findings = [];
  for (const f of findUrls(text)) {
    const d = f.mode === 'full' ? decide(f.url, cfg) : (prodPatternHit(f.url, cfg, [f.raw]) || { decision: 'allow' });
    if (d.decision !== 'allow') findings.push({ url: f.raw, ...d });
  }
  return findings;
}

// ── config, and the CLI the shell hooks call ───────────────────────────────────────────────────
function loadConfig(file) {
  if (!file || !fs.existsSync(file)) return { cfg: {}, error: null, found: false };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { cfg: {}, error: `${file} is not valid JSON: ${e.message}`, found: true }; }
  const pp = (doc && doc.productionProtection) || {};
  return {
    cfg: {
      prodUrlPatterns: Array.isArray(pp.prodUrlPatterns) ? pp.prodUrlPatterns : [],
      allowedUrlPatterns: Array.isArray(pp.allowedUrlPatterns) ? pp.allowedUrlPatterns : [],
      blockOnSuspiciousUrls: pp.blockOnSuspiciousUrls,
      testEnvironmentBaseUrl: doc && doc.environments && doc.environments.testEnvironmentBaseUrl,
    },
    error: null,
    found: true,
  };
}

// What is wrong with the configuration itself, as [{ code, message }]. A run whose configuration is unsafe must not go on: the per-command hook
// (prod-guard.sh) refuses every command while this is non-empty, and the session-start hook tells the user.
//   NO_CONFIG, NO_PROD_PATTERNS, NO_TEST_ENV_URL   enforce mode only: with nothing configured, nothing proves a target is safe
//   TEST_ENV_IS_PROD                               any mode: the configured test environment IS a production URL, in any spelling
function configProblems(cfg, mode, { found = true } = {}) {
  const problems = [];
  if (!found) {
    if (mode === 'enforce') problems.push({ code: 'NO_CONFIG', message: 'qa-config.json was not found, and guard mode is enforce (QA_AUTONOMOUS=1 or productionProtection.mode): an unattended run needs a configured workspace' });
    return problems;
  }
  const patterns = (cfg.prodUrlPatterns || []).filter(Boolean);
  if (mode === 'enforce' && !patterns.length) problems.push({ code: 'NO_PROD_PATTERNS', message: 'productionProtection.prodUrlPatterns is empty, and guard mode is enforce: an unattended run must have production URL patterns configured' });
  if (mode === 'enforce' && !cfg.testEnvironmentBaseUrl) problems.push({ code: 'NO_TEST_ENV_URL', message: 'environments.testEnvironmentBaseUrl is not set, and guard mode is enforce: set your staging URL' });
  if (cfg.testEnvironmentBaseUrl) {
    const hit = prodPatternHit(cfg.testEnvironmentBaseUrl, cfg);
    if (hit) problems.push({ code: 'TEST_ENV_IS_PROD', message: `environments.testEnvironmentBaseUrl (${cfg.testEnvironmentBaseUrl}) matches the production pattern ${hit.detail}: qa-config.json points the tests at PRODUCTION`, detail: hit.detail });
  }
  return problems;
}

function main(argv = process.argv.slice(2)) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const mode = opt('--mode') === 'enforce' ? 'enforce' : 'warn';
  const { cfg, error, found } = loadConfig(opt('--config'));
  const text = fs.readFileSync(0, 'utf8');
  process.stdout.write(`${JSON.stringify({ configError: error, mode, configProblems: error ? [] : configProblems(cfg, mode, { found }), findings: scan(text, { ...cfg, mode }) })}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (e) { process.stderr.write(`url-guard: ${e.message}\n`); process.exitCode = 1; }
}

module.exports = { decide, scan, extractUrls, findUrls, configProblems, prodPatternHit, parseUrl, toIPv4, loadConfig, NONPROD_TOKENS, PROD_TOKENS };

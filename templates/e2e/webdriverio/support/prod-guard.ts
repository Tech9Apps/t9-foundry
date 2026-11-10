/**
 * Layer 5: Runtime production guard for WebDriverIO.
 * Called from wdio.conf.ts onPrepare before any test executes.
 */
export interface ProdGuardOptions {
  /**
   * Throw when the URL is not recognizably non-production, instead of only warning.
   * Defaults to true when QA_AUTONOMOUS=1 (unattended runs fail closed — a
   * warning nobody reads is not a guard).
   */
  enforce?: boolean;
  /** Regex strings for URLs that are known-safe; exempt from the heuristic only. */
  allowedUrlPatterns?: string[];
  /** false disables the heuristic (qa-config.json productionProtection.blockOnSuspiciousUrls). */
  heuristic?: boolean;
  /** qa-config.json environments.testEnvironmentBaseUrl: this exact host is the declared test environment. */
  testEnvironmentBaseUrl?: string;
}

export interface GuardDecision {
  decision: 'allow' | 'warn' | 'block';
  reason: string;
  detail?: string;
}

/** Derive guard options from a loaded qa-config.json (see qa-config-loader). */
export function guardOptionsFromConfig(qa: Record<string, unknown>): ProdGuardOptions {
  const pp = (qa as {
    productionProtection?: {
      mode?: string;
      allowedUrlPatterns?: string[];
      blockOnSuspiciousUrls?: boolean;
    };
  }).productionProtection;
  const env = (qa as { environments?: { testEnvironmentBaseUrl?: string } }).environments;
  return {
    enforce: process.env.QA_AUTONOMOUS === '1' || pp?.mode === 'enforce',
    allowedUrlPatterns: pp?.allowedUrlPatterns ?? [],
    heuristic: pp?.blockOnSuspiciousUrls !== false,
    testEnvironmentBaseUrl: env?.testEnvironmentBaseUrl,
  };
}

// ── The decision procedure. A port of hooks/lib/url-guard.js (the reference): tests/fixtures/guard-cases.json is run against every
// implementation, so a change here must be made there too (and the other ports) or that table fails. ───────────────────────────
const NONPROD_TOKENS = new Set(['staging', 'stage', 'stg', 'test', 'testing', 'dev', 'develop', 'development', 'qa', 'uat', 'sandbox', 'sbx', 'preprod', 'preview', 'integration']);
const PROD_TOKENS = new Set(['prod', 'production', 'live', 'prd']);
const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost', 'local']);
const DOC_HOSTS = ['example.com', 'example.org', 'example.net'];
const BUILTIN_EXEMPT_HOSTS = ['github.com', 'githubusercontent.com', 'gitlab.com', 'bitbucket.org', 'dev.azure.com', 'visualstudio.com', 'api.clickup.com', 'atlassian.net', 'atlassian.com',
  'registry.npmjs.org', 'npmjs.org', 'npmjs.com', 'registry.yarnpkg.com', 'pypi.org', 'pythonhosted.org', 'rubygems.org', 'nodejs.org'];

const onLabelBoundary = (host: string, domain: string): boolean => host === domain || host.endsWith('.' + domain);

interface ParsedUrl { scheme: string; host: string; port: string; v6: boolean; path: string; verifiable: boolean }

function parseUrl(url: string): ParsedUrl | null {
  const m = /^(https?):\/\/([^/?#]*)([^?#]*)/i.exec(String(url));
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const authority = m[2];
  if (authority.includes('\\')) return null;
  const at = authority.lastIndexOf('@');
  const hostport = at >= 0 ? authority.slice(at + 1) : authority;
  let host: string; let port = ''; let v6 = false;
  if (hostport.startsWith('[')) {
    const b = /^\[([^\]]*)\](?::(\d*))?$/.exec(hostport);
    if (!b) return null;
    host = b[1].toLowerCase(); port = b[2] || ''; v6 = true;
  } else {
    const b = /^([^:]*)(?::(\d*))?$/.exec(hostport);
    if (!b) return null;
    host = b[1].toLowerCase().replace(/\.+$/, ''); port = b[2] || '';
  }
  if (!host) return null;
  const path = m[3] === '' ? '/' : m[3];
  const verifiable = v6 ? /^[0-9a-f:.]+$/.test(host) : /^[a-z0-9._-]+$/.test(host);
  return { scheme, host, port, v6, path, verifiable };
}

function toIPv4(host: string): string | null {
  if (!/^[0-9a-fx.]+$/i.test(host)) return null;
  const parts = host.split('.');
  if (parts.length > 4 || parts.some((p) => p === '')) return null;
  const nums: number[] = [];
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

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function isPrivateV6(host: string): boolean {
  if (host === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  const ip = mapped ? toIPv4(mapped[1]) : null;
  return !!ip && isPrivateV4(ip);
}

function nonProdHost(u: ParsedUrl): boolean {
  if (u.v6) return isPrivateV6(u.host);
  const ip = toIPv4(u.host);
  if (ip) return isPrivateV4(ip);
  if (u.host === 'localhost' || u.host.endsWith('.localhost')) return true;
  const labels = u.host.split('.');
  if (labels.length > 1 && RESERVED_TLDS.has(labels[labels.length - 1])) return true;
  if (DOC_HOSTS.some((d) => onLabelBoundary(u.host, d))) return true;
  const tokens = labels.slice(0, -1).join('.').split(/[._-]/).filter(Boolean);
  if (tokens.some((t) => PROD_TOKENS.has(t))) return false;
  return tokens.some((t) => NONPROD_TOKENS.has(t));
}

function candidates(url: string, u: ParsedUrl): string[] {
  const out = new Set<string>([String(url)]);
  const hosts = [u.host];
  const ip = u.v6 ? null : toIPv4(u.host);
  if (ip && ip !== u.host) hosts.push(ip);
  for (const h of hosts) {
    const hs = u.v6 ? '[' + h + ']' : h;
    out.add(u.scheme + '://' + hs + u.path); out.add(hs);
    if (u.port) { out.add(u.scheme + '://' + hs + ':' + u.port + u.path); out.add(hs + ':' + u.port); }
  }
  return [...out];
}

function compile(p: string, flags?: string): RegExp | null {
  try { return new RegExp(p, flags); } catch { return null; }
}

// Does `re` first match INSIDE "scheme://host[:port]", the first `end` characters of `form`? (A match that begins at the first character of the path is not inside it.)
function startsAtHost(re: RegExp, form: string, end: number): boolean {
  const m = re.exec(form);
  return m !== null && m.index < end;
}

export interface DecideConfig {
  mode?: 'enforce' | 'warn';
  prodUrlPatterns?: string[];
  allowedUrlPatterns?: string[];
  blockOnSuspiciousUrls?: boolean;
  testEnvironmentBaseUrl?: string;
}

export function decideUrl(url: string, cfg: DecideConfig = {}): GuardDecision {
  const enforce = cfg.mode === 'enforce';
  const failing = (reason: string, detail?: string): GuardDecision => ({ decision: enforce ? 'block' : 'warn', reason, ...(detail ? { detail } : {}) });
  const u = parseUrl(url);

  const forms = u && u.verifiable ? candidates(url, u) : [String(url)];
  for (const pattern of cfg.prodUrlPatterns ?? []) {
    const re = pattern ? compile(pattern, 'i') : null;
    if (re && forms.some((f) => re.test(f))) return { decision: 'block', reason: 'PROD_PATTERN', detail: pattern };
  }

  if (cfg.blockOnSuspiciousUrls === false) return { decision: 'allow', reason: 'HEURISTIC_DISABLED' };

  if (!u) return failing('UNPARSEABLE', 'not an http(s) URL with a plain host');
  if (!u.verifiable) return failing('UNVERIFIABLE_HOST', 'the host contains a variable, escape, or non-plain character');

  if (BUILTIN_EXEMPT_HOSTS.some((d) => onLabelBoundary(u.host, d))) return { decision: 'allow', reason: 'EXEMPT_HOST' };
  const authority = u.scheme + '://' + (u.v6 ? '[' + u.host + ']' : u.host) + (u.port ? ':' + u.port : '');
  const stripped = authority + u.path; // no userinfo, query or fragment
  const plainAuthority = u.scheme + '://' + u.host;
  // An allow pattern has to START matching within "scheme://host[:port]". It may go on into the path ("://partner\\.io/guide" allows what is under /guide), but
  // text that merely appears later, inside the path of some other host ("https://evil.com/go/https://partner.io/guide"), allows nothing.
  for (const pattern of cfg.allowedUrlPatterns ?? []) {
    const re = pattern ? compile(pattern) : null; // an invalid allow-pattern never exempts anything
    if (re && (startsAtHost(re, stripped, authority.length) || startsAtHost(re, plainAuthority + u.path, plainAuthority.length))) return { decision: 'allow', reason: 'ALLOWED_PATTERN', detail: pattern };
  }
  const testEnv = cfg.testEnvironmentBaseUrl ? parseUrl(cfg.testEnvironmentBaseUrl) : null;
  if (testEnv && testEnv.verifiable && testEnv.host === u.host) return { decision: 'allow', reason: 'TEST_ENV_HOST' };

  if (nonProdHost(u)) return { decision: 'allow', reason: 'NONPROD_HOST' };
  return failing('UNRECOGNIZED_HOST');
}

export function validateNotProduction(
  baseURL: string,
  prodPatterns: string[],
  options: ProdGuardOptions = {},
): void {
  const enforce = options.enforce ?? process.env.QA_AUTONOMOUS === '1';
  const d = decideUrl(baseURL, {
    mode: enforce ? 'enforce' : 'warn',
    prodUrlPatterns: prodPatterns,
    allowedUrlPatterns: options.allowedUrlPatterns ?? [],
    blockOnSuspiciousUrls: options.heuristic === false ? false : undefined,
    testEnvironmentBaseUrl: options.testEnvironmentBaseUrl,
  });
  if (d.decision === 'allow') return;

  if (d.reason === 'PROD_PATTERN') {
    throw new Error(
      '\n\n' +
      '╔══════════════════════════════════════════════════════════╗\n' +
      '║  PRODUCTION GUARD TRIGGERED — TESTS BLOCKED             ║\n' +
      '╠══════════════════════════════════════════════════════════╣\n' +
      '║  BASE_URL "' + baseURL + '"\n' +
      '║  matches production pattern: "' + d.detail + '"\n' +
      '║\n' +
      '║  Tests MUST NOT run against production.\n' +
      '║  Set BASE_URL to your staging or test environment.\n' +
      '╚══════════════════════════════════════════════════════════╝\n'
    );
  }
  if (d.decision === 'block') {
    throw new Error(
      '\n\nPRODUCTION GUARD TRIGGERED — TESTS BLOCKED\n' +
      'BASE_URL "' + baseURL + '" is not recognizably a test environment (' + d.reason + ') and guard mode is "enforce" ' +
      '(QA_AUTONOMOUS=1 or productionProtection.mode).\n' +
      'Set BASE_URL to your staging URL, or add a regex for this URL to ' +
      'productionProtection.allowedUrlPatterns in qa-config.json if it is safe.\n'
    );
  }
  console.warn(
    '\nWARNING: BASE_URL "' + baseURL + '" may be a production URL (' + d.reason + ').\n' +
    'Configure productionProtection.prodUrlPatterns in qa-config.json to enable strict blocking.\n'
  );
}

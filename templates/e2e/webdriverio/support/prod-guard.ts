/**
 * Layer 5: Runtime production guard for WebDriverIO.
 * Called from wdio.conf.ts onPrepare before any test executes.
 */
export interface ProdGuardOptions {
  /**
   * Throw on a suspicious-URL heuristic match instead of only warning.
   * Defaults to true when QA_AUTONOMOUS=1 (unattended runs fail closed — a
   * warning nobody reads is not a guard).
   */
  enforce?: boolean;
  /** Regex strings for URLs that are known-safe; exempt from the heuristic only. */
  allowedUrlPatterns?: string[];
  /** false disables the heuristic (qa-config.json productionProtection.blockOnSuspiciousUrls). */
  heuristic?: boolean;
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
  return {
    enforce: process.env.QA_AUTONOMOUS === '1' || pp?.mode === 'enforce',
    allowedUrlPatterns: pp?.allowedUrlPatterns ?? [],
    heuristic: pp?.blockOnSuspiciousUrls !== false,
  };
}

function isAllowedUrl(baseURL: string, allowed: string[]): boolean {
  for (const pattern of allowed) {
    if (!pattern) continue;
    try {
      if (new RegExp(pattern).test(baseURL)) return true;
    } catch {
      // Invalid regex — never treat it as a match.
    }
  }
  return false;
}

export function validateNotProduction(
  baseURL: string,
  prodPatterns: string[],
  options: ProdGuardOptions = {},
): void {
  for (const pattern of prodPatterns) {
    if (!pattern) continue;
    try {
      if (new RegExp(pattern).test(baseURL)) {
        throw new Error(
          `\n\n` +
          `╔══════════════════════════════════════════════════════════╗\n` +
          `║  PRODUCTION GUARD TRIGGERED — TESTS BLOCKED             ║\n` +
          `╠══════════════════════════════════════════════════════════╣\n` +
          `║  BASE_URL "${baseURL}"\n` +
          `║  matches production pattern: "${pattern}"\n` +
          `║\n` +
          `║  Tests MUST NOT run against production.\n` +
          `║  Set BASE_URL to your staging or test environment.\n` +
          `╚══════════════════════════════════════════════════════════╝\n`
        );
      }
    } catch (e) {
      if ((e as Error).message.includes('PRODUCTION GUARD')) throw e;
      // Invalid regex pattern — skip it
    }
  }

  // Heuristic check — always runs as an additional layer, not just when no
  // patterns are configured, so it still catches unconfigured prod-like
  // domains even after a team has added their first real pattern.
  if (options.heuristic === false) return;
  if (isAllowedUrl(baseURL, options.allowedUrlPatterns ?? [])) return;

  const enforce = options.enforce ?? process.env.QA_AUTONOMOUS === '1';
  const suspiciousPatterns = [
    /^https?:\/\/(?!staging\.|test\.|dev\.|qa\.|localhost|127\.0\.0\.1)[a-z0-9-]+\.[a-z]{2,}(?:\/|$)/i,
  ];
  for (const pattern of suspiciousPatterns) {
    if (pattern.test(baseURL)) {
      if (enforce) {
        throw new Error(
          `\n\nPRODUCTION GUARD TRIGGERED — TESTS BLOCKED\n` +
          `BASE_URL "${baseURL}" looks like a production URL and guard mode is "enforce" ` +
          `(QA_AUTONOMOUS=1 or productionProtection.mode).\n` +
          `Set BASE_URL to your staging URL, or add a regex for this URL to ` +
          `productionProtection.allowedUrlPatterns in qa-config.json if it is safe.\n`
        );
      }
      console.warn(
        `\nWARNING: BASE_URL "${baseURL}" may be a production URL.\n` +
        `Configure productionProtection.prodUrlPatterns in qa-config.json to enable strict blocking.\n`
      );
    }
  }
}

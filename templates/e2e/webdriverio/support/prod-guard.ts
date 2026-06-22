/**
 * Layer 5: Runtime production guard for WebDriverIO.
 * Called from wdio.conf.ts onPrepare before any test executes.
 */
export function validateNotProduction(baseURL: string, prodPatterns: string[]): void {
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

  // Heuristic check when no patterns are configured
  if (prodPatterns.length === 0) {
    const suspiciousPatterns = [
      /^https?:\/\/(?!staging\.|test\.|dev\.|qa\.|localhost|127\.0\.0\.1)[a-z0-9-]+\.[a-z]{2,}(?:\/|$)/i,
    ];
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(baseURL)) {
        console.warn(
          `\nWARNING: BASE_URL "${baseURL}" may be a production URL.\n` +
          `Configure productionProtection.prodUrlPatterns in qa-config.json to enable strict blocking.\n`
        );
      }
    }
  }
}

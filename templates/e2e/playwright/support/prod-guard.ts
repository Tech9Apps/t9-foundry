/**
 * Layer 5: Runtime production guard.
 * Called from global-setup.ts and cypress.config.ts before any test executes.
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

  // Heuristic check — always runs as an additional layer, not just when no
  // patterns are configured, so it still catches unconfigured prod-like
  // domains even after a team has added their first real pattern.
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

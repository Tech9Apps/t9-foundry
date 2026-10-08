import { defineConfig } from 'cypress';
import { loadQAConfig } from './support/qa-config-loader';
import { validateNotProduction, guardOptionsFromConfig } from './support/prod-guard';
import { DataFactory } from './support/data-factory';

const qa = loadQAConfig();
const baseUrl = process.env.BASE_URL || (qa as { environments?: { testEnvironmentBaseUrl?: string } }).environments?.testEnvironmentBaseUrl;

if (!baseUrl) {
  throw new Error(
    'BASE_URL is not set. Set it via environment variable or configure environments.testEnvironmentBaseUrl in qa-config.json.'
  );
}

const prodPatterns: string[] =
  (qa as { productionProtection?: { prodUrlPatterns?: string[] } }).productionProtection?.prodUrlPatterns ||
  (process.env.QA_PROD_PATTERNS ? JSON.parse(process.env.QA_PROD_PATTERNS) : []);

// Layer 5: production guard — crashes at config load time
validateNotProduction(baseUrl, prodPatterns, guardOptionsFromConfig(qa));

export default defineConfig({
  e2e: {
    baseUrl,
    supportFile: 'cypress/support/e2e.ts',
    specPattern: 'cypress/e2e/**/*.cy.{ts,js}',
    screenshotOnRunFailure: true,
    video: false,

    setupNodeEvents(on, config) {
      on('before:run', () => {
        console.log(`\n✓ QA Harness — test environment: ${baseUrl}`);
        console.log(`✓ Production guard: active (${prodPatterns.length} patterns)\n`);
      });

      on('after:run', async () => {
        console.log('\n→ QA Harness: cleaning up test data...');
        await DataFactory.cleanupAll();
        console.log('✓ Test data cleanup complete.\n');
      });

      return config;
    },
  },
});

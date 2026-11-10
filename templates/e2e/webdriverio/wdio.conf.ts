import { Options } from '@wdio/types';
import { loadQAConfig } from './support/qa-config-loader';
import { validateNotProduction, guardOptionsFromConfig } from './support/prod-guard';
import { DataFactory } from './support/data-factory';

const qa = loadQAConfig();
const baseURL: string =
  process.env.BASE_URL ||
  (qa.environments as { testEnvironmentBaseUrl?: string })?.testEnvironmentBaseUrl ||
  '';

export const config: Options.Testrunner = {
  runner: 'local',
  autoCompileOpts: {
    autoCompile: true,
    tsNodeOpts: { project: './tsconfig.json' },
  },

  specs: ['./test/**/*.test.ts'],
  exclude: [],

  maxInstances: 4,

  capabilities: [
    {
      browserName: 'chrome',
      'goog:chromeOptions': {
        args: process.env.CI ? ['--headless', '--no-sandbox', '--disable-dev-shm-usage'] : [],
      },
    },
  ],

  logLevel: 'warn',
  bail: 0,
  baseUrl: baseURL,

  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,

  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },

  // ── Layer 5: Production guard ─────────────────────────────────────────────
  async onPrepare() {
    const prodPatterns: string[] =
      (qa.productionProtection as { prodUrlPatterns?: string[] })?.prodUrlPatterns ?? [];
    validateNotProduction(baseURL, prodPatterns, guardOptionsFromConfig(qa));
    console.log(`\n✓ QA Harness — test environment: ${baseURL}\n`);
  },

  // ── Teardown: clean up DataFactory entities ───────────────────────────────
  async onComplete() {
    await DataFactory.cleanupAll();
  },
};

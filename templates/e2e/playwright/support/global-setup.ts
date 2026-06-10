import { FullConfig } from '@playwright/test';
import { loadQAConfig } from './qa-config-loader';
import { validateNotProduction } from './prod-guard';
import * as fs from 'fs';
import * as path from 'path';

export default async function globalSetup(config: FullConfig) {
  const qa = loadQAConfig();
  const baseURL = process.env.BASE_URL || qa.environments?.testEnvironmentBaseUrl || config.projects[0]?.use?.baseURL;

  if (!baseURL) {
    throw new Error(
      'BASE_URL is not set. Set it via environment variable or configure environments.testEnvironmentBaseUrl in qa-config.json.'
    );
  }

  // Layer 5: Production guard — crashes before a single test runs
  const prodPatterns = getProdPatterns(qa);
  validateNotProduction(baseURL, prodPatterns);

  // Ensure auth directory exists
  const authDir = path.join(process.cwd(), 'playwright/.auth');
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  console.log(`\n✓ QA Harness — test environment: ${baseURL}`);
  console.log(`✓ Production guard: active (${prodPatterns.length} patterns)\n`);
}

function getProdPatterns(qa: Record<string, unknown>): string[] {
  const envPatterns = process.env.QA_PROD_PATTERNS ? JSON.parse(process.env.QA_PROD_PATTERNS) : [];
  const configPatterns = (qa as { productionProtection?: { prodUrlPatterns?: string[] } })
    .productionProtection?.prodUrlPatterns || [];
  return [...new Set([...envPatterns, ...configPatterns])];
}

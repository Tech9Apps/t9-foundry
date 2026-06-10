import { FullConfig } from '@playwright/test';
import { DataFactory } from '../fixtures/data-factory';

export default async function globalTeardown(_config: FullConfig) {
  console.log('\n→ QA Harness: cleaning up test data...');
  await DataFactory.cleanupAll();
  console.log('✓ Test data cleanup complete.\n');
}

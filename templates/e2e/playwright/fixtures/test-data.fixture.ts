import { test as base } from '@playwright/test';
import { DataFactory } from './data-factory';

// Extend this type with the fixtures your tests need
type TestFixtures = {
  testUser: Awaited<ReturnType<typeof DataFactory.createUser>>;
};

/**
 * Extended test object with data factory fixtures.
 * Import `test` from this file instead of `@playwright/test` to get
 * access to pre-created test data that cleans up automatically.
 *
 * Usage:
 *   import { test, expect } from '../fixtures/test-data.fixture';
 *
 *   test('user can log in', async ({ page, testUser }) => {
 *     await page.goto('/login');
 *     await page.fill('[name=email]', testUser.email);
 *     // ...
 *   });
 */
export const test = base.extend<TestFixtures>({
  testUser: async ({}, use) => {
    const user = await DataFactory.createUser();
    await use(user);
    // Cleanup is handled by global-teardown.ts via DataFactory.cleanupAll()
    // Add per-test cleanup here only if you need to clean up mid-test
  },
});

export { expect } from '@playwright/test';

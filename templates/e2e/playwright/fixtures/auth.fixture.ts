import { test as setup, expect } from '@playwright/test';
import * as path from 'path';

const authFile = path.join(process.cwd(), 'playwright/.auth/user.json');

/**
 * Authentication setup — runs once before all tests in the chromium project.
 * Saves browser state (cookies + localStorage) to playwright/.auth/user.json.
 * Tests reuse this stored state, so each test doesn't need to log in.
 *
 * Customize the login flow below for your application.
 * File name: auth.setup.ts (matched by playwright.config.ts testMatch pattern)
 */
setup('authenticate', async ({ page }) => {
  const baseURL = process.env.BASE_URL;
  const testEmail = process.env.TEST_USER_EMAIL;
  const testPassword = process.env.TEST_USER_PASSWORD;

  if (!testEmail || !testPassword) {
    console.warn(
      'TEST_USER_EMAIL or TEST_USER_PASSWORD not set. ' +
      'Add them to your .env.test file. Skipping authentication setup.'
    );
    return;
  }

  // TODO: Replace with your application's login flow
  await page.goto('/login');
  await page.fill('[name="email"]', testEmail);
  await page.fill('[name="password"]', testPassword);
  await page.click('[type="submit"]');

  // Wait for successful login — adjust the selector to match your app
  await expect(page).toHaveURL(/dashboard|home/);

  await page.context().storageState({ path: authFile });
});

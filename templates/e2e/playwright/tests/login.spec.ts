/**
 * Example e2e test — Login flow
 *
 * Import `test` and `expect` from the test-data fixture (not @playwright/test
 * directly) so the `testUser` fixture and data factory cleanup are available.
 *
 * Replace the LoginPage import path and page object calls with your app's
 * actual selectors once you've updated pages/login.page.ts.
 */
import { test, expect } from '../fixtures/test-data.fixture';
import { LoginPage } from '../pages/login.page';

test.describe('Login', () => {
  test('user can log in with valid credentials', async ({ page, testUser }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    // TODO: Replace 'Test@1234!' with your test account password (read from process.env)
    await loginPage.login(testUser.email, process.env.TEST_USER_PASSWORD ?? 'Test@1234!');
    await expect(page).toHaveURL(/dashboard|home/);
  });

  test('shows error with invalid credentials', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login('notauser@example-test.com', 'wrongpassword');
    await expect(loginPage.errorMessage).toBeVisible();
  });

  test('redirects unauthenticated users to login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/login/);
  });
});

/**
 * Example e2e test — Login flow (WebDriverIO / Mocha)
 *
 * Replace the LoginPage import and page object calls with your app's
 * actual selectors once you've updated pages/login.page.ts.
 */
import LoginPage from '../pages/login.page';

describe('Login', () => {
  it('user can log in with valid credentials', async () => {
    await LoginPage.open();
    // TODO: Replace with a real test account from process.env
    await LoginPage.login(
      process.env.TEST_USER_EMAIL ?? 'test@example-test.com',
      process.env.TEST_USER_PASSWORD ?? 'Test@1234!',
    );
    await expect(browser).toHaveUrlContaining('/dashboard');
  });

  it('shows an error with invalid credentials', async () => {
    await LoginPage.open();
    await LoginPage.login('notauser@example-test.com', 'wrongpassword');
    await expect(LoginPage.errorMessage).toBeDisplayed();
  });

  it('redirects unauthenticated users to login', async () => {
    await browser.url('/dashboard');
    await expect(browser).toHaveUrlContaining('/login');
  });
});

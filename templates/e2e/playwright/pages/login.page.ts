import { Page, Locator } from '@playwright/test';

/**
 * LoginPage — Page Object for the login screen.
 *
 * Selectors use data-testid attributes. If your app uses different attributes,
 * update the locators here — test files stay unchanged.
 *
 * Add a Page Object for every distinct screen or component your tests interact
 * with. Keep all selector logic here; keep all assertions in the test file.
 */
export class LoginPage {
  readonly page: Page;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    // TODO: Replace with your app's actual selector attributes
    this.emailInput = page.getByTestId('email');
    this.passwordInput = page.getByTestId('password');
    this.submitButton = page.getByRole('button', { name: /sign in|log in/i });
    this.errorMessage = page.getByTestId('login-error');
  }

  async goto() {
    await this.page.goto('/login');
  }

  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }
}

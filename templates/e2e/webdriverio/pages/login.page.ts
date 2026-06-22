/**
 * LoginPage — Page Object for the login screen (WebDriverIO).
 *
 * Selectors use data-testid attributes. Update the attribute values to
 * match your application — the test files stay unchanged.
 */
export class LoginPage {
  get emailInput() {
    return $('[data-testid="email"]');
  }

  get passwordInput() {
    return $('[data-testid="password"]');
  }

  get submitButton() {
    // TODO: Update the button text / selector to match your app
    return $('button[type="submit"]');
  }

  get errorMessage() {
    return $('[data-testid="login-error"]');
  }

  async open() {
    await browser.url('/login');
  }

  async login(email: string, password: string) {
    await this.emailInput.setValue(email);
    await this.passwordInput.setValue(password);
    await this.submitButton.click();
  }
}

export default new LoginPage();

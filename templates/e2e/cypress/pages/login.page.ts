/**
 * LoginPage — Page Object for the login screen.
 *
 * All Cypress selectors live here. Test files call methods, never query the
 * DOM directly. Update selectors here when the UI changes; tests stay clean.
 *
 * Using data-testid attributes (preferred). Fall back to ARIA roles if
 * data-testid attributes are not available in the app.
 */
export class LoginPage {
  visit() {
    cy.visit('/login');
  }

  // TODO: Replace with your app's actual selector attributes
  fillEmail(email: string) {
    cy.get('[data-testid="email"]').type(email);
  }

  fillPassword(password: string) {
    cy.get('[data-testid="password"]').type(password, { log: false });
  }

  submit() {
    cy.get('[type="submit"]').click();
  }

  errorMessage() {
    return cy.get('[data-testid="login-error"]');
  }
}

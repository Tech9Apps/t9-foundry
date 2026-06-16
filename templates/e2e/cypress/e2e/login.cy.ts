/**
 * Example e2e test — Login flow
 *
 * Uses the LoginPage Page Object for all UI interactions and the
 * cy.createTestUser() command (from support/commands.ts) for test data.
 *
 * Update pages/login.page.ts with your app's actual selectors.
 * The test data created here is cleaned up automatically after the run
 * via DataFactory.cleanupAll() in cypress.config.ts > after:run.
 */
import { LoginPage } from '../pages/login.page';

describe('Login', () => {
  it('user can log in with valid credentials', () => {
    cy.createTestUser().then((user) => {
      const loginPage = new LoginPage();
      loginPage.visit();
      loginPage.fillEmail(user.email);
      // TODO: set TEST_USER_PASSWORD in cypress.env.json or .env.test
      loginPage.fillPassword(Cypress.env('TEST_USER_PASSWORD') ?? 'Test@1234!');
      loginPage.submit();
      cy.url().should('match', /dashboard|home/);
    });
  });

  it('shows error with invalid credentials', () => {
    const loginPage = new LoginPage();
    loginPage.visit();
    loginPage.fillEmail('notauser@example-test.com');
    loginPage.fillPassword('wrongpassword');
    loginPage.submit();
    loginPage.errorMessage().should('be.visible');
  });

  it('redirects unauthenticated users to login', () => {
    cy.visit('/dashboard');
    cy.url().should('include', '/login');
  });
});

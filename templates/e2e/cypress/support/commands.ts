import { DataFactory } from './data-factory';

// Augment Cypress namespace so TypeScript knows about custom commands
declare global {
  namespace Cypress {
    interface Chainable {
      createTestUser(attrs?: Record<string, unknown>): Chainable<ReturnType<typeof DataFactory.createUser>>;
      loginAs(email: string, password: string): Chainable<void>;
    }
  }
}

Cypress.Commands.add('createTestUser', (attrs = {}) => {
  return cy.wrap(DataFactory.createUser(attrs));
});

Cypress.Commands.add('loginAs', (email: string, password: string) => {
  // TODO: Replace with your application's login flow
  cy.visit('/login');
  cy.get('[name="email"]').type(email);
  cy.get('[name="password"]').type(password);
  cy.get('[type="submit"]').click();
  cy.url().should('match', /dashboard|home/);
});

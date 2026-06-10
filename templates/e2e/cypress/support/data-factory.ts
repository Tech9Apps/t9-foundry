/**
 * DataFactory — Registry pattern for Cypress test data management.
 * Mirrors the Playwright version. All created entities are cleaned up
 * in cypress.config.ts after:run via DataFactory.cleanupAll().
 */

interface CreatedEntity {
  type: string;
  id: string | number;
  cleanupFn?: () => Promise<void>;
}

interface User {
  id: string;
  email: string;
  role?: string;
  [key: string]: unknown;
}

export class DataFactory {
  private static registry: CreatedEntity[] = [];

  static async createUser(attrs: Partial<User> = {}): Promise<User> {
    const defaults: Partial<User> = {
      email: `test-${Date.now()}@example-test.com`,
      role: 'user',
    };

    // TODO: Replace with your application's user creation API call
    const response = await fetch(`${Cypress.config('baseUrl')}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...defaults, ...attrs }),
    });

    if (!response.ok) {
      throw new Error(`DataFactory.createUser failed: ${response.status} ${await response.text()}`);
    }

    const user: User = await response.json();

    this.registry.push({
      type: 'user',
      id: user.id,
      cleanupFn: async () => {
        await fetch(`${Cypress.config('baseUrl')}/api/users/${user.id}`, {
          method: 'DELETE',
        }).catch(() => {});
      },
    });

    return user;
  }

  static async cleanupAll(): Promise<void> {
    const entities = [...this.registry].reverse();
    this.registry = [];

    await Promise.allSettled(
      entities.map((entity) => entity.cleanupFn?.())
    );
  }

  static getRegistry(): CreatedEntity[] {
    return [...this.registry];
  }
}

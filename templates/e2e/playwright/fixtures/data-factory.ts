/**
 * DataFactory — Registry pattern for test data management.
 *
 * Every entity created via this factory is registered and cleaned up
 * automatically in global-teardown.ts after the full test run.
 *
 * Usage:
 *   const user = await DataFactory.createUser({ role: 'admin' });
 *   // user is automatically cleaned up after the run — no manual delete needed
 *
 * Customize the entity methods below to match your application's API.
 * The cleanup registry and cleanupAll() method should not need changes.
 */

interface CreatedEntity {
  type: string;
  id: string | number;
  cleanupFn?: () => Promise<void>;
}

// Replace these types with your application's actual entity shapes
interface User {
  id: string;
  email: string;
  role?: string;
  [key: string]: unknown;
}

// Add your application's entity types here
// interface Order { id: string; ... }
// interface Product { id: string; ... }

export class DataFactory {
  private static registry: CreatedEntity[] = [];

  // ─── Entity Factories ─────────────────────────────────────────────────────
  // Replace these with your application's actual API calls.
  // Follow the pattern: create via API, register for cleanup, return entity.

  static async createUser(attrs: Partial<User> = {}): Promise<User> {
    const defaults: Partial<User> = {
      email: `test-${Date.now()}@example-test.com`,
      role: 'user',
    };

    // TODO: Replace with your application's user creation API call
    const response = await fetch(`${process.env.BASE_URL}/api/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // TODO: add auth header if required for user creation
      },
      body: JSON.stringify({ ...defaults, ...attrs }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`DataFactory.createUser failed: ${response.status} ${await response.text()}`);
    }

    const user: User = await response.json();

    this.registry.push({
      type: 'user',
      id: user.id,
      cleanupFn: async () => {
        await fetch(`${process.env.BASE_URL}/api/users/${user.id}`, {
          method: 'DELETE',
          // TODO: add auth header if required
          signal: AbortSignal.timeout(10_000),
        }).catch((err) => {
          console.warn(`DataFactory cleanup warning (user ${user.id}):`, err);
        });
      },
    });

    return user;
  }

  // Add more factory methods here following the same pattern:
  //
  // static async createOrder(attrs: Partial<Order> = {}): Promise<Order> {
  //   const order = await apiClient.post('/api/orders', { ...defaults, ...attrs });
  //   this.registry.push({ type: 'order', id: order.id });
  //   return order;
  // }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  static async cleanupAll(): Promise<void> {
    const entities = [...this.registry].reverse(); // reverse to respect FK constraints
    this.registry = [];

    const results = await Promise.allSettled(
      entities.map(async (entity) => {
        if (entity.cleanupFn) {
          await entity.cleanupFn();
        }
      })
    );

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      console.warn(`DataFactory.cleanupAll: ${failed.length} cleanup(s) failed (may already be deleted)`);
    }
  }

  static getRegistry(): CreatedEntity[] {
    return [...this.registry];
  }

  static clearRegistry(): void {
    this.registry = [];
  }
}

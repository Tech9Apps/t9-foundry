import fetch from 'node-fetch';

type CleanupFn = () => Promise<void>;

interface RegistryEntry {
  type: string;
  id: string | number;
  cleanup: CleanupFn;
}

/**
 * Registry-based test data factory for WebDriverIO.
 *
 * Every entity created via this factory is registered for cleanup.
 * DataFactory.cleanupAll() is called automatically in wdio.conf.ts onComplete.
 *
 * Customize the entity methods to match your application's API.
 */
export class DataFactory {
  private static registry: RegistryEntry[] = [];

  // ── Entity factories ───────────────────────────────────────────────────────

  static async createUser(attrs: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const baseURL = process.env.BASE_URL;
    if (!baseURL) throw new Error('BASE_URL is not set');

    const payload = {
      email: `test-${Date.now()}@example-test.com`,
      role: 'user',
      ...attrs,
    };

    // TODO: Replace with your application's user creation API endpoint
    const res = await fetch(`${baseURL}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`createUser failed: ${res.status} ${await res.text()}`);
    const user = (await res.json()) as Record<string, unknown>;

    DataFactory.registry.push({
      type: 'user',
      id: user['id'] as string,
      cleanup: async () => {
        await fetch(`${baseURL}/api/users/${user['id']}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(10_000),
        });
      },
    });
    return user;
  }

  // Add more factory methods following the same pattern:
  //
  // static async createOrder(attrs = {}) {
  //   const baseURL = process.env.BASE_URL!;
  //   const res = await fetch(`${baseURL}/api/orders`, { method: 'POST', ... });
  //   const order = await res.json();
  //   DataFactory.registry.push({ type: 'order', id: order.id, cleanup: async () => { ... } });
  //   return order;
  // }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  static async cleanupAll(): Promise<void> {
    const entries = [...DataFactory.registry].reverse();
    for (const entry of entries) {
      try {
        await entry.cleanup();
      } catch (err) {
        console.warn(`DataFactory cleanup warning (${entry.type} ${entry.id}):`, err);
      }
    }
    DataFactory.registry = [];
  }

  static getRegistry(): RegistryEntry[] {
    return [...DataFactory.registry];
  }
}

# E2E Test Data Patterns

Choose the pattern that fits your application's architecture. The templates default to the **Registry (Factory)** pattern.

---

## Pattern 1: Registry / Factory (Default)

**Best for:** API-driven applications where the app has REST endpoints for creating and deleting entities.

Every entity created in a test is registered in `DataFactory._registry`. After all tests complete, `globalTeardown` (Playwright) or the `after:run` event (Cypress) calls `DataFactory.cleanupAll()`, which deletes all registered entities in reverse creation order.

```typescript
// In your test
const user = await DataFactory.createUser({ role: 'admin' });
const order = await DataFactory.createOrder({ userId: user.id, status: 'pending' });
// No explicit cleanup needed — handled by globalTeardown
```

**Cleanup order matters for foreign keys.** The registry deletes in reverse creation order by default, so if `order` depends on `user`, `order` is deleted first.

**When an entity is already gone** (deleted during the test itself), the cleanup ignores the 404 error (`catch(() => {})`).

---

## Pattern 2: Database Seed / Rollback (Transactions)

**Best for:** Apps with direct database access or a test helper API that supports transactions.

Wrap each test in a database transaction that is rolled back after the test. No explicit cleanup needed.

```typescript
// Playwright: use API route to begin/rollback transaction
test.beforeEach(async ({ request }) => {
  await request.post('/api/test/begin-transaction');
});

test.afterEach(async ({ request }) => {
  await request.post('/api/test/rollback-transaction');
});
```

**Requirement:** Your application must expose test-only endpoints for transaction management, or you must have direct DB access from the test process. Never enable transaction endpoints in production — gate them behind `NODE_ENV !== 'production'`.

---

## Pattern 3: Snapshot / Restore

**Best for:** Applications running in Docker where the database can be snapshotted.

Before the test run, take a database snapshot. After the run, restore it.

```bash
# In globalSetup
docker exec my-db pg_dump -U postgres mydb > /tmp/test-snapshot.sql

# In globalTeardown
docker exec my-db psql -U postgres mydb < /tmp/test-snapshot.sql
```

**Caution:** Slow for large databases. Works well for isolated test environments.

---

## Pattern 4: Tag-Based Cleanup

**Best for:** Applications that tag entities with metadata and support filtering by tag.

Tag every test entity with a `testRunId` (derived from the test run timestamp). After the run, query for all entities with that tag and delete them.

```typescript
const RUN_ID = `test-run-${process.env.TEST_RUN_ID || Date.now()}`;

static async createUser(attrs = {}) {
  const user = await api.post('/users', { ...attrs, tags: ['e2e-test', RUN_ID] });
  return user;
}

static async cleanupAll() {
  const testEntities = await api.get(`/users?tag=${RUN_ID}`);
  await Promise.all(testEntities.map(u => api.delete(`/users/${u.id}`)));
}
```

**Advantage:** Works even if a test run crashes mid-execution — re-run cleanup with the same `RUN_ID` to catch leftover data.

---

## Pattern 5: API Teardown (Explicit Delete)

**Best for:** Apps without a data factory but with full REST API coverage.

Each test explicitly creates and deletes its own data. No global registry needed.

```typescript
test('user can view their orders', async ({ page, request }) => {
  // Setup
  const user = await request.post('/api/users', { data: { email: 'test@example.com' } });
  const order = await request.post('/api/orders', { data: { userId: user.id } });

  try {
    // Test
    await page.goto(`/users/${user.id}/orders`);
    await expect(page.getByText(order.id)).toBeVisible();
  } finally {
    // Teardown — always runs even if test fails
    await request.delete(`/api/orders/${order.id}`);
    await request.delete(`/api/users/${user.id}`);
  }
});
```

**Downside:** Verbose. Prefer the registry pattern for maintainability.

---

## Choosing a Pattern

| Pattern | Requires | Best for |
|---------|---------|---------|
| Registry (Factory) | App API with delete endpoints | Most apps |
| Seed / Rollback | Test-mode transaction API or direct DB | Full-stack apps with DB access |
| Snapshot / Restore | Docker / disposable DB | Isolated CI environments |
| Tag-based cleanup | Tag support in the app API | Apps where cleanup may need re-running |
| API Teardown | Full REST coverage | Simple apps, small test suites |

Configure your chosen strategy in `qa-config.json > dataManagement.strategy`.

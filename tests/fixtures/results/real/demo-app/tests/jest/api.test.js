const base = process.env.BASE || 'http://127.0.0.1:4567';
const get = (p) => fetch(base + p);
const { helperThatDoesNotExist } = require('./helpers'); // a bug in the TEST: this export does not exist

describe('api', () => {
  for (let i = 0; i < 12; i += 1) test('DEMO-9/TC-9' + String(i).padStart(2, '0') + ': filler ' + i, async () => { expect((await get('/health')).status).toBe(200); });
  test('DEMO-1/TC-001: health is ok', async () => { expect((await get('/health')).status).toBe(200); });
  test('DEMO-1/TC-002: the cart total is 11', async () => { const r = await (await get('/api/total')).json(); expect(r.total).toBe(11); });
  test('DEMO-1/TC-003: the reports service answers 200', async () => { expect((await get('/api/unavailable')).status).toBe(200); });
  test('DEMO-1/TC-004: the secure endpoint is reachable', async () => { expect((await get('/api/secure')).status).toBe(200); });
  test('DEMO-1/TC-005: the archive page exists', async () => { expect((await get('/api/missing')).status).toBe(200); });
  test('DEMO-1/TC-006: the payment service is reachable', async () => { const r = await fetch('http://127.0.0.1:9/pay'); expect(r.status).toBe(200); });
  test('DEMO-1/TC-007: the helper formats a price', () => { expect(helperThatDoesNotExist(5)).toBe('$5.00'); });
  test('DEMO-1/TC-008: the slow report finishes', async () => { expect((await get('/api/slow')).status).toBe(200); }, 1500);
});

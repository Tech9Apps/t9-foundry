const { test, expect } = require('@playwright/test');
test('DEMO-2/TC-001: the Apply button is on the cart panel', async ({ page }) => { await page.goto('/cart'); await page.getByTestId('coupon-apply-btn').click({ timeout: 2000 }); });
test('DEMO-2/TC-002: the Apply button says "Apply now"', async ({ page }) => { await page.goto('/cart'); await expect(page.getByTestId('coupon-apply')).toHaveText('Apply now', { timeout: 2000 }); });
test('DEMO-2/TC-003: the coupon box is on the cart panel', async ({ page }) => { await page.goto('/cart'); await expect(page.getByTestId('coupon-input')).toBeVisible(); });

'use strict';
// SEEDED SCENARIO: stale selector. The app's Apply button is data-testid="coupon-apply"; this test still looks for
// the name it had before a UI refactor. The app is fine, the test is stale. Expected triage: test-bug (TST-1).

const test = require('node:test');
const { openPage } = require('../support/page');

test('DEMO-101/TC-901: the Apply button is on the cart panel', () => {
  const page = openPage();
  page.getByTestId('coupon-apply-btn');
});

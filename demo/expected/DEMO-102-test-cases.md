# Test Cases: DEMO-102 - Correct order total, tax, and free shipping

> **Sample output.** TC-001…TC-008 are automated in `demo/app/test/order-totals.test.js` (same IDs in the test
> names); TC-009 is a UI formatting check left for a browser/manual pass.

## Ticket Summary
`total = (subtotal − discount) + shipping + tax`. Tax is 8% of the discounted subtotal, rounded to the cent.
Shipping is $5.00, free when the discounted subtotal is $50.00 or more. Checkout rejects an empty cart and returns an
order matching the cart totals.

## Module / Feature
Cart & Checkout → Pricing (`GET /api/cart`, `POST /api/checkout`)

## Preconditions
- App running; signed in as `ada@brewandco.test`; empty cart unless a case says otherwise

## Test Cases

### TC-001: Total equals subtotal + shipping + tax (no discount)
- **Priority:** High
- **Type:** Positive
- **Description:** Baseline arithmetic with no discount.
- **Test data:** Espresso Beans ($24.00) + Ceramic Mug ($12.00) = $36.00
- **Steps:** 1. Add both items. 2. Read the totals.
- **Expected Result:** Subtotal $36.00, shipping $5.00, tax $2.88, total $43.88.
- **Selectors/Elements:** `cart-subtotal`, `cart-shipping`, `cart-tax`, `cart-total`
- **Traceability:** DEMO-102 AC1, AC2, AC3

### TC-002: Tax is 8% of the discounted subtotal, rounded to the nearest cent
- **Priority:** High
- **Type:** Edge Case
- **Description:** Tax is computed after the discount and rounds correctly (370.8¢ → 371¢).
- **Test data:** Cold Brew Kit ($39.50) + Ceramic Mug ($12.00) = $51.50; code `BREW10` (−$5.15)
- **Steps:** 1. Add both items. 2. Apply `BREW10`.
- **Expected Result:** Discounted subtotal $46.35; tax $3.71.
- **Selectors/Elements:** `cart-tax`, `cart-discount`
- **Traceability:** DEMO-102 AC2

### TC-003: Shipping is a flat $5.00 below the threshold
- **Priority:** Medium
- **Type:** Positive
- **Description:** Orders under $50.00 pay flat shipping.
- **Test data:** Pour-Over Kit ($25.00)
- **Steps:** 1. Add one Pour-Over Kit.
- **Expected Result:** Shipping $5.00.
- **Selectors/Elements:** `cart-shipping`
- **Traceability:** DEMO-102 AC3

### TC-004: Shipping is free at exactly $50.00
- **Priority:** High
- **Type:** Edge Case (boundary)
- **Description:** The threshold is inclusive.
- **Test data:** 2 × Pour-Over Kit = $50.00
- **Steps:** 1. Add two Pour-Over Kits.
- **Expected Result:** Shipping $0.00.
- **Selectors/Elements:** `cart-shipping`
- **Traceability:** DEMO-102 AC4

### TC-005: Shipping is free well above the threshold
- **Priority:** Low
- **Type:** Positive
- **Test data:** Burr Grinder ($89.00)
- **Steps:** 1. Add one Burr Grinder.
- **Expected Result:** Shipping $0.00.
- **Selectors/Elements:** `cart-shipping`
- **Traceability:** DEMO-102 AC4

### TC-006: Free shipping is judged on the discounted subtotal
- **Priority:** High
- **Type:** Edge Case (interaction)
- **Description:** A cart that is over $50.00 before a discount but under it afterwards must still pay shipping.
- **Test data:** Cold Brew Kit + Ceramic Mug = $51.50; code `WELCOME5` (−$5.00) → $46.50
- **Steps:** 1. Add both items. 2. Note shipping ($0.00 if free). 3. Apply `WELCOME5`.
- **Expected Result:** After the code, discounted subtotal is $46.50 and shipping is $5.00.
- **Selectors/Elements:** `cart-shipping`, `cart-discount`
- **Traceability:** DEMO-102 AC4 (and Known Risk: threshold × discounts)

### TC-007: Checking out an empty cart is rejected
- **Priority:** Medium
- **Type:** Negative
- **Steps:** 1. With an empty cart, `POST /api/checkout`.
- **Expected Result:** HTTP 400, `EMPTY_CART`, "Your cart is empty".
- **Selectors/Elements:** `checkout-submit` (disabled in the UI when empty)
- **Traceability:** DEMO-102 AC5

### TC-008: Checkout returns an order matching the cart totals and empties the cart
- **Priority:** High
- **Type:** Positive
- **Test data:** Espresso Beans + Ceramic Mug
- **Steps:** 1. Build the cart and note totals. 2. Place the order. 3. Re-read the cart.
- **Expected Result:** Order ID like `ORD-1001`; order totals equal the noted totals; cart is empty.
- **Selectors/Elements:** `checkout-submit`, `order-confirmation`
- **Traceability:** DEMO-102 AC6

### TC-009: Amounts display as dollars with two decimals
- **Priority:** Low
- **Type:** UI Validation
- **Steps:** 1. Add any item. 2. Inspect each totals line.
- **Expected Result:** Every amount renders as `$N.NN`; discount renders with a leading minus.
- **Selectors/Elements:** `cart-subtotal`, `cart-discount`, `cart-shipping`, `cart-tax`, `cart-total`
- **Traceability:** DEMO-102 Technical Notes — *manual / browser only*

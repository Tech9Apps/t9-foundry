# Test Cases: DEMO-101 - Apply a discount code at checkout

> **Sample output.** This is what `/write-test-cases DEMO-101` produces for the demo ticket. Your run will differ in
> wording — that is expected. Cases TC-001…TC-008 are automated in `demo/app/test/discount-codes.test.js`
> (the test names carry the same IDs); TC-009 and TC-010 are UI checks left for a browser/manual pass.

## Ticket Summary
Shoppers can enter a discount code on the cart. `BREW10` = 10% off, `WELCOME5` = $5.00 off. One code per order,
codes are case-insensitive, discounts never push the subtotal below zero, and applying a code requires sign-in.

## Module / Feature
Cart & Checkout → Discount codes (`POST /api/cart/coupon`, cart panel in `public/index.html`)

## Preconditions
- App running; signed in as `ada@brewandco.test` (password in the ticket notes — demo data only)
- Empty cart unless a case says otherwise

## Test Cases

### TC-001: BREW10 takes 10% off the subtotal
- **Priority:** High
- **Type:** Positive
- **Description:** A valid percentage code reduces the order by exactly 10% of the subtotal.
- **Test data:** cart = Espresso Beans ($24.00) + Ceramic Mug ($12.00), subtotal $36.00; code `BREW10`
- **Steps:**
  1. Add Espresso Beans and Ceramic Mug to the cart.
  2. Enter `BREW10` and click **Apply**.
- **Expected Result:** Discount shows −$3.60; discounted subtotal $32.40.
- **Selectors/Elements:** `coupon-input`, `coupon-apply`, `cart-discount`
- **Traceability:** DEMO-101 AC1

### TC-002: WELCOME5 takes a flat $5.00 off
- **Priority:** High
- **Type:** Positive
- **Description:** A fixed-amount code reduces the order by $5.00 regardless of cart size.
- **Test data:** cart = Espresso Beans ($24.00); code `WELCOME5`
- **Steps:** 1. Add Espresso Beans. 2. Apply `WELCOME5`.
- **Expected Result:** Discount −$5.00; discounted subtotal $19.00.
- **Selectors/Elements:** `coupon-input`, `coupon-apply`, `cart-discount`
- **Traceability:** DEMO-101 AC1

### TC-003: Codes are case-insensitive and ignore surrounding spaces
- **Priority:** Medium
- **Type:** Edge Case
- **Description:** `  brew10 ` is treated as `BREW10`.
- **Test data:** code typed as `␣␣brew10␣`
- **Steps:** 1. Add any item. 2. Type the code with lowercase letters and spaces around it. 3. Apply.
- **Expected Result:** Code is accepted; applied code is `BREW10`.
- **Selectors/Elements:** `coupon-input`, `coupon-apply`
- **Traceability:** DEMO-101 AC2

### TC-004: An unknown code is rejected and the order is unchanged
- **Priority:** High
- **Type:** Negative
- **Description:** An invalid code shows the specified message and changes nothing.
- **Test data:** code `NOPE`
- **Steps:** 1. Add any item. 2. Note the totals. 3. Apply `NOPE`.
- **Expected Result:** Message "Invalid discount code"; discount stays −$0.00; totals identical to step 2.
- **Selectors/Elements:** `coupon-error`, `cart-discount`
- **Traceability:** DEMO-101 AC3

### TC-005: Applying the same code twice does not stack the discount
- **Priority:** High
- **Type:** Negative
- **Description:** "One code per order" includes re-applying the same code; the second attempt is rejected and the
  discount stays at 10%.
- **Test data:** cart = Espresso Beans + Ceramic Mug ($36.00); `BREW10` applied twice
- **Steps:** 1. Build the cart. 2. Apply `BREW10`. 3. Apply `BREW10` again.
- **Expected Result:** Second attempt rejected ("Only one discount code per order"); discount remains −$3.60.
- **Selectors/Elements:** `coupon-apply`, `coupon-error`, `cart-discount`
- **Traceability:** DEMO-101 AC4

### TC-006: A second, different code is rejected
- **Priority:** High
- **Type:** Negative
- **Description:** Only one discount code per order, even when the codes differ.
- **Test data:** `BREW10` then `WELCOME5`
- **Steps:** 1. Add an item. 2. Apply `BREW10`. 3. Apply `WELCOME5`.
- **Expected Result:** "Only one discount code per order"; only `BREW10` is applied.
- **Selectors/Elements:** `coupon-error`, `cart-discount`
- **Traceability:** DEMO-101 AC4

### TC-007: A discount can never push the subtotal below $0.00
- **Priority:** Medium
- **Type:** Edge Case
- **Description:** A fixed discount larger than the cart is capped at the subtotal.
- **Test data:** cart = Sample Sachet ($3.00); code `WELCOME5` ($5.00)
- **Steps:** 1. Add the Sample Sachet only. 2. Apply `WELCOME5`.
- **Expected Result:** Discount −$3.00; discounted subtotal $0.00 (not negative).
- **Selectors/Elements:** `cart-subtotal`, `cart-discount`
- **Traceability:** DEMO-101 AC5

### TC-008: Applying a code requires being signed in
- **Priority:** Medium
- **Type:** Negative
- **Description:** The coupon endpoint refuses unauthenticated requests.
- **Steps:** 1. Without signing in, `POST /api/cart/coupon` with `{ "code": "BREW10" }`.
- **Expected Result:** HTTP 401, error code `UNAUTHENTICATED`.
- **Selectors/Elements:** — (API check)
- **Traceability:** DEMO-101 AC6

### TC-009: Coupon errors appear inline without a page reload
- **Priority:** Low
- **Type:** UI Validation
- **Description:** The error text renders in the cart panel and the page does not navigate.
- **Steps:** 1. Sign in. 2. Apply `NOPE`. 3. Observe the cart panel and the browser URL.
- **Expected Result:** "Invalid discount code" appears under the input; URL and cart contents unchanged.
- **Selectors/Elements:** `coupon-error`
- **Traceability:** DEMO-101 AC3 — *manual / browser only*

### TC-010: Cart totals update immediately after applying a code
- **Priority:** Medium
- **Type:** UI Validation
- **Description:** Discount, tax and total refresh in place when a valid code is applied.
- **Steps:** 1. Add an item. 2. Note totals. 3. Apply `BREW10`.
- **Expected Result:** Discount, tax and total change at once; no reload.
- **Selectors/Elements:** `cart-discount`, `cart-tax`, `cart-total`
- **Traceability:** DEMO-101 AC1 — *manual / browser only*

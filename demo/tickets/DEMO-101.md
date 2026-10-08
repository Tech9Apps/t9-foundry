# DEMO-101: Apply a discount code at checkout

**Type:** User Story   **Priority:** High   **Component:** Cart & Checkout

## Summary

As a shopper, I want to enter a discount code on my cart so that I pay less for my order.

## Description

Marketing is launching two codes this week: `BREW10` (10% off) and `WELCOME5` ($5.00 off for first-time customers).
The shopper types a code into the cart, clicks **Apply**, and the cart totals update immediately. The cart is the
source of truth for pricing — the checkout charges whatever the cart shows.

### Acceptance Criteria

1. A valid code reduces the order: `BREW10` takes 10% off the subtotal; `WELCOME5` takes a flat $5.00 off.
2. Codes are not case-sensitive and surrounding spaces are ignored (`  brew10 ` works).
3. An unknown code shows "Invalid discount code" and leaves the order unchanged.
4. **Only one discount code can be used per order.** Trying to add a second code is rejected with
   "Only one discount code per order" (this includes re-applying the same code).
5. A discount can never make the subtotal negative.
6. Only signed-in shoppers can apply a code.

## Technical Notes

- `POST /api/cart/coupon` with `{ "code": "BREW10" }` returns the updated cart (items, applied coupons, totals).
- Money is stored and calculated in integer cents.
- Error shape: `{ "error": { "code": "INVALID_COUPON", "message": "Invalid discount code" } }`

## Known Risk Areas

- Marketing may stack campaigns later, so the "one code" rule must be explicit and enforced server-side.
- Discount math feeds tax and shipping (see DEMO-102).

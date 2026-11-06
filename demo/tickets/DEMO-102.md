# DEMO-102: Correct order total, tax, and free shipping

**Type:** User Story   **Priority:** High   **Component:** Cart & Checkout

## Summary

As a shopper, I want the cart to show an accurate total — including tax and shipping — so that the amount I'm
charged matches what I was shown.

## Description

The total is built from four lines: subtotal, discount (DEMO-101), shipping, and tax. Finance needs these to be
exactly right because the checkout charges the cart total.

### Acceptance Criteria

1. `total = (subtotal − discount) + shipping + tax`.
2. Tax is **8% of the discounted subtotal** (not of shipping), rounded to the nearest cent.
3. Shipping is a flat $5.00.
4. Shipping is **free when the discounted subtotal is $50.00 or more** (so exactly $50.00 ships free).
5. Checking out an empty cart is rejected with "Your cart is empty".
6. Checkout returns an order whose totals equal the cart totals, then empties the cart.

## Technical Notes

- `GET /api/cart` returns `totals: { subtotal, discount, discounted, shipping, tax, total }` in cents.
- `POST /api/checkout` returns `{ id: "ORD-1001", items, coupons, totals }`.

## Known Risk Areas

- The free-shipping threshold interacts with discount codes — a discount can drop a cart back under $50.00.
- Rounding: values must stay integer cents end to end.

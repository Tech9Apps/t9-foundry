# Bug: Free-shipping threshold ignores the discount, so discounted orders under $50.00 ship free

> **Sample output** of `/file-bug` — see the note in `bug-DEMO-101-coupon-stacking.md`.

**Related ticket:** DEMO-102 (AC4) · **Failing check:** `DEMO-102/TC-006` · **Reproduced:** yes, deterministic

## Environment
- Brew & Co demo app, `http://localhost:4173` (local test environment — never production)
- Account: `ada@brewandco.test`

## Steps to Reproduce
1. Sign in and add a Cold Brew Kit ($39.50) and a Ceramic Mug ($12.00) — subtotal $51.50, shipping $0.00 (correct).
2. Apply `WELCOME5` (−$5.00) → discounted subtotal $46.50.

## Expected Result
The discounted subtotal ($46.50) is under $50.00, so shipping returns to $5.00.

## Actual Result
Shipping stays at $0.00. The threshold is evaluated against the pre-discount subtotal ($51.50).

| | Expected | Actual |
|---|---|---|
| Shipping | $5.00 | $0.00 |
| Total | $55.22 | $50.22 |

## Evidence
```
not ok 20 - DEMO-102/TC-006: free shipping is judged on the discounted subtotal
  expected: 500
  actual: 0
```
Reproduce: `cd demo/app && node --test test/order-totals.test.js`

Note the neighbouring boundary checks **pass** (`TC-003` $25.00 pays shipping, `TC-004` exactly $50.00 ships free,
`TC-005` $89.00 ships free) — the defect only appears when a discount moves a cart across the threshold. That is why
the ticket's "Known Risk Areas" called out the threshold × discount interaction.

## Severity / Priority
**Medium / P3** — $5.00 revenue leak per affected order; only affects carts that straddle the threshold after a
discount. Violates an explicit acceptance criterion.

## Suspected Area
`demo/app/src/pricing.js` → `priceCart()`: `shipping = … subtotal >= FREE_SHIPPING_MIN …` should compare `discounted`.

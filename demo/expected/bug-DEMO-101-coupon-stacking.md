# Bug: Discount code can be applied repeatedly and stacks beyond the "one code per order" rule

> **Sample output** of `/file-bug`. With `ticketSource.type: "none"` the report is saved to
> `{testCasesDir}/bugs/`; with Jira/Azure/ClickUp/GitHub/GitLab/Bitbucket it is filed there after your approval.

**Related ticket:** DEMO-101 (AC4) · **Failing check:** `DEMO-101/TC-005` · **Reproduced:** yes, deterministic

## Environment
- Brew & Co demo app, `http://localhost:4173` (local test environment — never production)
- Account: `ada@brewandco.test`

## Steps to Reproduce
1. Sign in and add Espresso Beans ($24.00) and a Ceramic Mug ($12.00) — subtotal $36.00.
2. Apply `BREW10` → discount −$3.60 (correct).
3. Apply `BREW10` a second time.

## Expected Result
The second application is rejected ("Only one discount code per order", HTTP 400) and the discount stays at −$3.60.

## Actual Result
HTTP 200. The cart now lists `["BREW10","BREW10"]` and the discount doubles to −$7.20 (20%). Each further application
adds another 10%.

| | Expected | Actual |
|---|---|---|
| Discount | $3.60 | $7.20 |
| Total | $39.99 | $36.10 |

The shopper is undercharged by **$3.89** on this cart, and the effect grows with every extra click.

## Evidence
```
not ok 5 - DEMO-101/TC-005: applying the same code twice does not stack the discount
  expected: 400
  actual: 200
```
Reproduce: `cd demo/app && node --test test/discount-codes.test.js`

## Severity / Priority
**High / P2** — direct revenue loss, trivially exploitable (click Apply repeatedly), violates an explicit acceptance
criterion. No data loss or security exposure.

## Suspected Area
`demo/app/src/store.js` → `addCoupon()`: the guard rejects a second code only when it is *different*
(`!cart.coupons.includes(code)`), so re-applying the same code falls through to `cart.coupons.push(code)`.
`pricing.js` then sums every entry in `cart.coupons`.

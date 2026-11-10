# Run Report — Brew & Co demo (3 tickets)

> **Sample output.** The shape of the summary a run ends with — and, once a tracker is connected, what is posted to
> the ticket. Numbers here come from the real demo suite: `cd demo/app && npm test`.

## Result at a glance

| Ticket | Feature | Cases | Automated | Pass | Fail | Verdict |
|--------|---------|------:|----------:|-----:|-----:|---------|
| DEMO-101 | Discount codes | 10 | 8 | 7 | **1** | ❌ blocked by a product bug |
| DEMO-102 | Totals, tax, shipping | 9 | 8 | 7 | **1** | ❌ blocked by a product bug |
| DEMO-103 | Sign-in & lockout | 7 | 6 | 6 | 0 | ✅ ready |

22 automated checks · 20 pass · 2 fail · the manual-only UI cases (DEMO-101 TC-009/010, DEMO-102 TC-009, DEMO-103
TC-007) are queued for a browser pass.

## Failures — triage

| Check | Classification | Why | Action |
|-------|----------------|-----|--------|
| DEMO-101/TC-005 | **Product bug** | Deterministic; app accepts a repeated code, violating AC4. Test is correct. | Bug filed → `bug-DEMO-101-coupon-stacking.md` |
| DEMO-102/TC-006 | **Product bug** | Deterministic; threshold uses the pre-discount subtotal, violating AC4. Test is correct. | Bug filed → `bug-DEMO-102-free-shipping-threshold.md` |

Neither failure is a flaky or environmental problem, and neither is a bad test — which is exactly the distinction a
tester spends the most time on.

## What a human would still decide
- Whether the two bugs block the release (the report recommends P2 and P3).
- Whether the manual-only UI cases need a browser pass this cycle.

## Coverage notes
- Every acceptance criterion in all three tickets has at least one case.
- Risk areas from the tickets were targeted deliberately: lockout timing (DEMO-103 TC-005) and the threshold ×
  discount interaction (DEMO-102 TC-006 — the case that found a bug).

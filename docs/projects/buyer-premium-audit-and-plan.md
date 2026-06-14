# Buyer Premium — Audit & Implementation Plan

**Status: AUDIT + DESIGN ONLY.** No code change. Grounded in current code.

## Audit — current state (definitive)
**No buyer premium is charged or displayed to buyers today. A buyer is charged exactly `lot.winning_amount_cents` (raw hammer price) — no premium, no tax.**

| Surface | Finding | Evidence |
|---|---|---|
| Schema (platform/auction/lot) | **ABSENT** | no premium column on auctions/lots/platform_settings |
| Schema (seller) | `buyer_premium_pct` exists **only** on `seller_terms` (contract-doc, per-seller) | `054_create_seller_terms.sql:11` |
| Stripe charge | **hammer price only** | `paymentService.js:270-315` charges `winning_amount_cents` |
| Invoice | single `amount_cents`, no line items | `invoiceService.js:8-17`; `029_create_invoices.sql` |
| Live bidding display | **ABSENT** | `lot.html` / `auction-view.html` show no premium/total |
| Bid confirmation | "Your Max Bid: $X" only | `lot.html:1458` |
| Emails | "Winning bid" only, no premium | `notificationContent.js` WINNING template |
| Buyer Terms v1 | **TEXT promises** "plus applicable buyer premium" | `061_create_terms.sql:56,66` (promised, unimplemented) |
| Admin edit per auction | **ABSENT** (only per-seller contract field) | `adminAgreements.js` sets `seller_terms.buyer_premium_pct` for documents only |

The 0% pilot stance is **intentional** (`docs/pilot-launch/buyer-premium-decision.md`), which already enumerates the files a real implementation must touch. `payment.html` even states "no hidden fees."

## Design — per-auction, admin-editable buyer premium
1. **Schema:** `auctions.buyer_premium_bps INTEGER` (basis points; nullable → fall back to a platform default in `platform_settings`). Optional seller default that an auction can override. Add `invoices.bid_amount_cents`, `invoices.buyer_premium_cents`, `invoices.tax_cents` (line-item breakdown). Persist the premium breakdown on the `payments` row too.
2. **Default + override:** platform default (config) → optional seller default → auction override (the auction value wins when set). Mirrors the increment override hierarchy.
3. **Charge calc:** `paymentService.createPaymentIntent` computes `amount = winning_amount_cents + premium (+ tax)` and persists the breakdown (not bare `winning_amount_cents`).
4. **Live display (the unmet "must show live" rule):** show the premium % and a running total alongside the live current bid on `lot.html` + `auction-view.html`; show the full breakdown at checkout (`payment.html`).
5. **Bid confirmation:** disclose "your max bid + premium = max total."
6. **Invoice + emails:** itemize hammer + premium (+ tax); WINNING email discloses the total.
7. **Admin edit path:** per-auction premium field in the moderation edit form + `PATCH /api/admin/auctions/:id` whitelist entry; **audit-logged**.
8. **Validation:** premium in a sane range (e.g., 0–25%); changes blocked once an auction is `closed`/has charges; reporting distinguishes gross-bid vs premium revenue.

> Implement **all together** — a piecemeal premium (charged-but-not-shown, or shown-but-not-charged) breaks the "no hidden fees" promise + Buyer Terms.

## Launch classification
- **If the pilot launches at 0% premium (current decision): buyer-premium editability is NOT required before public launch** (nothing to charge/show).
- **Required before Stripe LIVE *only if* a premium will be charged.** If any non-zero premium is desired before real charges, the full implementation above (incl. live display + Buyer Terms v2 disclosure) is a **hard prerequisite** for LIVE.
- Decision needed from ownership: **launch at 0% premium, or implement premium before LIVE?** Recommendation: launch the TEST-mode public auction at **0%** (no blocker), and treat "non-zero buyer premium" as a **Required-before-Stripe-LIVE** workstream bundled with the Terms v2 money clauses and the tax decision.

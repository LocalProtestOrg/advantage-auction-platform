# Buyer Premium — Pilot Launch Decision

*Last updated: 2026-05-11 | Pilot-Safe Payments Sprint*
*Owner: Advantage Auction / Human Operator*

---

## Decision

**Buyer premium rate for controlled pilot launch: 0%**

For the initial controlled pilot auction, no buyer premium is charged above the
winning bid amount. The payment intent is created for the exact winning bid in cents.

This is an explicit operational decision, not an implementation gap.

---

## Current Payment Math (pilot)

```
charge_amount = winning_amount_cents          // raw winning bid
platform_fee  = winning_amount_cents * 0.10   // 10% — seller-side, not charged to buyer
seller_payout = winning_amount_cents - platform_fee
```

The buyer pays the bid price. The platform retains 10% from the seller's proceeds.
No additional amount is collected from the buyer at checkout.

---

## Verified Consistency

The following locations are consistent with a 0% buyer premium:

| File | Location | Behavior |
|---|---|---|
| `src/services/paymentService.js` | `createPaymentIntent()` | Charges `lot.winning_amount_cents` exactly |
| `src/services/reportingService.js` | `generateAuctionReport()` | Reports gross = winning bid sum, no premium |
| `src/services/auctionService.js` | `closeAuction()` | Payout calc uses same 10% platform fee on gross |
| `src/services/invoiceService.js` | `createInvoice()` | Invoice `amount_cents` = payment `amount_cents` |

All four locations agree. There is no hidden buyer premium applied anywhere.

---

## PLATFORM_FEE_RATE Duplication Risk

`PLATFORM_FEE_RATE = 0.10` is defined independently in two files:

- `src/services/reportingService.js:62`
- `src/services/auctionService.js:290`

These are currently in sync. **If the platform fee rate ever changes, both must
be updated atomically.** A future sprint should extract this to a shared constant
or make it admin-configurable via `platform_settings`.

---

## When Buyer Premium Becomes Non-Zero

If buyer premium is introduced in a future cycle, the following files require
coordinated changes:

1. **`src/services/paymentService.js`** — `createPaymentIntent()` must add premium to amount
2. **`src/services/invoiceService.js`** — invoice must store `bid_amount_cents` and
   `buyer_premium_cents` as separate line items
3. **`public/payment.html`** — display must show bid + premium breakdown
4. **`public/lot.html`** — live bidding UI must show current premium alongside live bid
5. Database schema — `invoices` table needs `buyer_premium_cents` column
6. Reporting — distinguish gross_bid_revenue from gross_collected_revenue

Do not implement buyer premium piecemeal. It requires simultaneous changes to
payment creation, invoice schema, and buyer-facing UI.

---

## Re-evaluation Trigger

This decision should be re-evaluated after the first pilot auction completes and
before any public launch. Review with Advantage leadership before implementing.

# First real storefront sale: controlled purchase and complete refund (Timeless Treasures, New Jersey)

Updated 2026-11-16 (owner direction). This replaces the earlier multi-item pilot plan (2026-11-10: items A to D, pickup,
reporting period and payout tests). The first live transaction is now **one purchase that is refunded in full**. The
payout is not part of this test.

- **Seller:** Timeless Treasures (seller profile `81d6f0ce-9f3c-4605-9c09-04cb9c1601fc`, storefront
  `https://bid.advantage.bid/pro/timeless-treasures`), a Professional Seller (Retail Shop, Gallery or Studio) with a
  confirmed pickup location in Jersey City, New Jersey.
- **Buyer:** an authorized pilot buyer account, separate from the seller and from both administrators.
- **Listing:** "Brass Candlestick Lamp with Milk Glass Shade", $3.00 plus $2.00 flat shipping, quantity 1. It is a
  **temporary test listing, not real merchandise**.
- **Lewis & Maese are not used** for any live purchase, refund or payout test, and none of their records are changed.

**Ground rules.**

- Real money moves: the pilot buyer pays with a real card. The transaction needs the **owner's explicit approval**.
- Global checkout stays OFF (`MARKETPLACE_CHECKOUT_ENABLED` unset). Only the two pilot allow-lists are used.
- **No fulfillment.** Nothing is shipped. No tracking number, shipment, delivery or pickup record is entered, and none
  is fabricated to move the order along.
- **No seller payout.** An unfulfilled, refunded order never becomes payable. The first payout is tested later, on a
  genuine sale of real merchandise.
- Advantage.Bid is a New Jersey business; the test is a New Jersey sale (shipped to a New Jersey address). How the sale
  is taxed is the CPA's determination (`docs/operations/storefront-sales-tax-decision-checklist.md`), not assumed here.

## Prerequisites (all must be true)

Status as of 2026-11-16. The launch checklist is `docs/projects/development-todo.md` section 1.

| # | Requirement | Status | How to confirm |
|---|---|---|---|
| P1 | Production healthy at the release that carries the purchase policies and the sales tax safeguard (d38a2da or later) | Done | `/api/health`; GitHub deployment |
| P2 | Buyer Terms Version 4 published | Done 2026-11-13 | `/buyer-terms.html` shows Version 4 |
| P3 | Seller ready: type Retail Shop, Gallery or Studio; business verification approved; Seller Agreement v4 signed; Store Terms v1 and Shipping & Pickup Policy v1 published; Jersey City pickup location confirmed; the listing published | Done | The seller's readiness list; pre-flight script |
| P4 | Live payout account for the seller (transfers and payouts active) | **Open, blocked:** on 2026-11-13 the payment processor returned "You must have Connect enabled on Accounts v2"; the owner enables it in the Stripe Dashboard (currently locked out pending a two-step authentication reset) | `/payout-profile.html` shows Ready for Payouts |
| P5 | Sales tax: the CPA's written determination for **New Jersey**, including its effect on auction invoices; the New Jersey rule entered in Admin > Tax Jurisdictions (`platform` or `seller_direct`; never `seller`); for `platform`, an active New Jersey registration in Stripe Tax (`docs/operations/storefront-tax-configuration-steps.md`) | **Open** | Admin > Tax Jurisdictions shows New Jersey; without it the safeguard refuses every order |
| P6 | Live webhook endpoint carries the payment, refund, dispute and transfer events (`docs/operations/stripe-live-webhook-verification.md`) | **Open** (Stripe Dashboard) | Owner checklist complete |
| P7 | Both administrator emails verified (the Admin/Finance sale notice goes only to verified addresses) | Confirm | Sign in as each > `https://bid.advantage.bid/verify-email.html` |
| P8 | Pilot buyer account created, email verified, separate from the seller and both administrators, with a New Jersey shipping address | **Open** | Account id recorded |
| P9 | Fresh production backup taken and verified the same day | On the day | Neon branch compared with production |
| P10 | Owner's approval of the real-money test and of both pilot lists; then `MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS=81d6f0ce-9f3c-4605-9c09-04cb9c1601fc` and `MARKETPLACE_CHECKOUT_PILOT_USER_IDS=<pilot buyer account id>`; `MARKETPLACE_CHECKOUT_ENABLED` stays unset | **Open** | Only that buyer sees Buy Now, and only on this seller's items |

Read-only progress check (changes nothing):
`railway run --service advantage-auction-platform --environment production node scripts/storefront-pilot-preflight.js --buyer <buyer email>`

## Expected amounts

| Line | Amount | Note |
|---|---|---|
| Item | $3.00 | |
| Flat shipping | $2.00 | |
| Sales tax | as calculated for New Jersey | Under `platform`: the amount Stripe Tax calculates for the New Jersey ship-to address. Under `seller_direct`: $0.00, nothing collected at checkout. Not predicted here. |
| **Buyer pays** | **$5.00 plus tax** | |
| Commission (Marketplace Sale, 9% of the item price only) | $0.27 | Shipping and tax are never in the commission base |
| Seller proceeds figure | $4.73 | $3.00 + $2.00 - $0.27. **Recorded on the order but never paid**, because the order is refunded before fulfillment |
| Card processing fee | actual, recorded on the order | **Not returned by the payment processor on a refund**; Advantage.Bid absorbs it (at standard card pricing of 2.9% + $0.30, roughly $0.45 on $5.00, a little more with tax) |

## Procedure

Each step is checked before the next. Stop on any stop rule below.

1. **Purchase.** The pilot buyer opens the listing on Advantage.Bid (not a website widget), chooses Buy Now and
   **shipping to a New Jersey address**, and reviews the order: the "Before you pay" rules, both policy links and the
   Buyer Terms; item $3.00, shipping $2.00, and a tax line that matches the New Jersey rule. The buyer pays with a real
   debit or credit card.
2. **Charge processed.** Admin > Marketplace Orders shows the order paid; the payment processor shows the payment and
   the `payment_intent.succeeded` delivery with HTTP 200; the actual card fee is recorded on the order within minutes.
3. **Sales tax calculated.** The tax charged equals the tax shown at review and matches the rule: the calculated New
   Jersey amount under `platform`, or none under `seller_direct`. The order records the tax, the jurisdiction and who
   remits it.
4. **Transaction recorded.** The order shows: channel Marketplace; commission 9% = $0.27; seller proceeds figure
   $4.73; total $5.00 plus tax; fulfillment method shipping; Buyer Terms Version 4 acceptance recorded. The listing
   shows as sold (quantity 0).
5. **Notifications verified.** The buyer's receipt; the seller's sale email; the Admin/Finance sale email (both
   administrators) and the owner's sale text.
6. **Complete refund.** An administrator refunds the order in Admin > Marketplace Orders (reason "Controlled test
   purchase: full refund"; who caused it: Advantage.Bid). The refund equals everything the buyer paid: item, shipping
   and tax.
7. **Tax reversal recorded.** The order shows the tax reversal reference; under `platform`, the tax transaction is
   reversed at the processor. (Under `seller_direct` there is no tax to reverse; confirm the order shows $0.00 tax.)
8. **Inventory back to quantity 1.** Confirm the listing's available quantity is 1 again and its history shows the
   sale and the refund. See the note below on how the quantity is restored.
9. **No physical shipment.** Nothing is sent.
10. **No tracking or delivery records.** The order has no tracking number and no shipped, delivered or picked-up
    status at any point.

Then switch the pilot off: unset the two pilot variables. Checkout is closed to everyone again.

**Note on step 8 (checked against the code on 2026-11-16).** A full refund takes the unit off the sold count and moves
a sold-out item to a non-public state; it does not by itself put the unit back on sale (the rule exists because real
goods may already have left). Unless that behavior is changed before the test, the quantity is set back to 1 by the
seller in the inventory page as an explicit step, and that change is recorded in the item's stock history. Because
this is a temporary test listing, it can stay unpublished or be removed after the test.

## Pass criteria after the full refund

- The processor's refund equals the full amount paid; the buyer's refund email arrives; `charge.refunded` is delivered
  with HTTP 200.
- Order: payment status refunded, **refund status refunded**, refunded amount equals the total charged.
- **Tax reversal recorded** (or $0.00 tax under `seller_direct`).
- **Item quantity back to 1.**
- **No payout:** the order is not eligible for payout, and no payout record line for it is paid (Admin > Storefront
  Payouts shows nothing to pay for this seller). No transfer to the seller exists at the processor.
- No shipment, tracking or delivery record exists.
- The commission ($0.27) and proceeds figure ($4.73) remain visible on the order as history only; nothing is paid
  to the seller on a fully refunded order.
- The card processing fee stays recorded as Advantage.Bid's cost of the test.

## Isolation checks (during the test)

- Another seller's items still show Contact Seller to the pilot buyer; this seller's items show Contact Seller to every
  other buyer and to signed-out visitors.
- No other seller's orders, payouts or readiness change (Admin > Marketplace Orders lists only the test order).
- Lewis & Maese: no orders, no payout records, no changes.

## Stop rules

Switch the pilot off at once (unset the two pilot variables) if: the tax line does not match the New Jersey rule (tax
missing where the rule says collected, or tax present where the rule says none); the commission is not $0.27; a webhook
delivery fails; the refund is less than the amount paid; the tax reversal is not recorded; the order becomes eligible
for payout or appears on a payout record; anything is charged twice; any other seller or buyer is affected. Browsing,
existing orders and refunds keep working with checkout off.

## Not covered by this test (later, on genuine sales)

- Fulfillment: pickup or shipment, tracking, delivery, and the buyer's reporting period.
- The seller payout: the weekly payout record and the "Pay Seller" transfer. It is tested on the first genuine sale of
  real merchandise.
- Website Sale (5%) through the shop's website widget, multi-quantity items, partial refunds, and sales to other
  states (each state needs its own rule first).

## After the test

Report the results to the owner. Opening checkout to more sellers (setting `MARKETPLACE_CHECKOUT_ENABLED=true` and
removing the pilot lists) needs the owner's explicit approval.

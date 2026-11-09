# First real storefront sale: test plan (Lewis & Maese)

Prepared 2026-11-09. Run only after every prerequisite below is met and the owner approves each step. Real money moves:
the owner buys with their own card, and Advantage.Bid absorbs the card fee that the processor keeps on a refunded payment
(about 2.9% + 30 cents).

## Prerequisites (all must be true)

| # | Requirement | How to confirm |
|---|---|---|
| P1 | Purchase-policy release (330ea1c) deployed; health OK | `/api/health` status ok; GitHub deployment = the release commit |
| P2 | Buyer Terms Version 4 (Part B fixed-price) published with Sales Near You flag; Terms of Service section 3A posted | `/buyer-terms.html` shows Version 4 with Part B |
| P3 | Texas sales tax decided and configured from the CPA's written determination (docs/operations/storefront-tax-configuration-steps.md) | Admin > Tax Jurisdictions (`/admin/tax-jurisdictions.html`) has the Texas rule; if tax is collected at checkout, the Stripe Dashboard Texas registration is active. Without the rule, the safeguard refuses every order (live since d38a2da) |
| P3a | Both administrator emails verified (the Admin/Finance sale notice goes only to verified addresses; both were unverified on 2026-11-09) | Sign in as each, `https://bid.advantage.bid/verify-email.html` > Resend Confirmation Email > click the link |
| P4 | Live webhook endpoint carries the storefront events (docs/operations/stripe-live-webhook-verification.md) | Stripe Dashboard check by the owner |
| P5 | Lewis & Maese signed Seller Agreement Version 4 | Their readiness list: "Seller agreement signed" done |
| P6 | Lewis & Maese direct deposit ready (live connected account) | Readiness: "Payout account ready" done |
| P7 | Lewis & Maese published Store Terms and a storefront Shipping & Pickup Policy | Readiness: "Store Terms and Shipping & Pickup Policy published" done; item page shows both links |
| P8 | Pilot switched on for the owner's buyer account and Lewis & Maese only | `MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS=118458af-6b07-4806-86a4-b927d2b0cbed`, `MARKETPLACE_CHECKOUT_PILOT_USER_IDS=<owner buyer id>`; `MARKETPLACE_CHECKOUT_ENABLED` stays unset |
| P9 | Fresh production backup taken and verified the same day | Neon branch compared with production (counts match) |

Test item: the lowest-priced item (Georgian gilt framed mirror, $180.00, pickup in Houston), or a low-priced item Lewis &
Maese add for the test. Expected amounts for a $180.00 item:

| | Marketplace Sale (9%) | Website Sale (5%) |
|---|---|---|
| Item | $180.00 | $180.00 |
| Storefront fee | $16.20 | $9.00 |
| Seller proceeds | $163.80 | $171.00 |
| Sales tax | per the Texas decision; if collected, the Houston rate from the Comptroller's rate locator (8.25% would be $14.85) | same |

## Test 1: payment (Marketplace Sale, 9%)

1. As the owner's buyer account, open the item from Advantage.Bid (not from the seller's website).
2. Buy Now, local pickup, review. **Check the review screen:** item $180.00; the sales tax line matches the Texas decision
   (stop if tax should be collected and shows $0); "Before you pay" rules shown; links to the seller's Store Terms,
   Shipping & Pickup Policy and the Buyer Terms.
3. Accept and pay with a real debit or credit card (not prepaid).
4. **Pass when:** confirmation with an MO- order number; Admin > Marketplace Orders shows the order paid, sales channel
   Marketplace, fee 9% ($16.20), seller proceeds $163.80, tax and remitter as configured, Buyer Terms version 4 recorded;
   the seller and Admin/Finance sale notices arrive; the owner's sale text arrives; the item shows SOLD publicly; the card
   processing fee appears on the order within minutes (the five-minute backfill).
5. Stripe Dashboard: the payment succeeded; the webhook delivery for `payment_intent.succeeded` shows HTTP 200; with Stripe
   Tax on, a tax transaction exists for the order.

## Test 2: full refund (no fee)

1. Admin > Marketplace Orders > the Test 1 order > Refund, reason "Controlled launch test", who caused it: Advantage.Bid.
2. **Pass when:** the Stripe refund equals the full amount paid (item + tax); the order shows Refunded; the buyer's refund
   email arrives; no fee was deducted; `charge.refunded` delivered with HTTP 200; the tax transaction is reversed in
   Stripe Tax. The refunded item is not put back on sale automatically: Lewis & Maese relist it if they wish.

## Test 3: Website Sale (5%)

Needs the Lewis & Maese storefront widget installed on **their own website** (a page that is not on advantage.bid). A
typed or shared link always counts as a Marketplace Sale.

1. On their website, open the item in the embedded storefront and click Buy Now (opens Advantage.Bid checkout).
2. Complete the purchase as in Test 1.
3. **Pass when:** the order shows sales channel Website, fee 5% ($9.00), seller proceeds $171.00, and the embedding site
   recorded. If the widget is not on their website yet, skip this test for the first sale; it is covered by automated
   tests and Stripe test mode.

## Test 4: pickup and the reporting period

Use the Test 3 order (or a second Marketplace purchase if Test 3 was skipped). This sale is kept, not refunded.

1. The owner collects the item in Houston. Lewis & Maese click **Pickup Complete** on their Marketplace Orders page.
2. **Pass when:** the buyer's My Purchases page shows the pickup time and "report any problem by" a date 48 hours later;
   the seller's order page shows when the reporting period ends; Admin shows the order fulfilled.
3. Optional (checks the payout-hold fix live, no money moves): the buyer reports a "Damaged" problem; the order's payout
   is held; Admin > Storefront Moderation shows the report "within the reporting period"; resolve it with "release the
   payout hold"; the order is payable again.

## Test 5: seller payout

1. The weekly payout includes a sale picked up at least 48 hours before the cutoff (Wednesday 11:59 PM Eastern). Pickup
   by Monday evening is in that Thursday's payout.
2. Thursday: Admin > Storefront Payouts (`/admin/storefront-payouts.html`). The prepared record lists the order with the
   proceeds (and the tax only if the Texas rule is `seller`).
3. Pay Seller: confirm the amount; one transfer to Lewis & Maese's connected account.
4. **Pass when:** the record shows paid; Stripe shows the transfer to their account (`transfer.created` delivered); Lewis &
   Maese confirm the deposit when their bank posts it.

## Test 6: tax records

- Each taxed order records the tax amount, Texas jurisdiction and remitter.
- Stripe Tax reports show the collected tax for the Test 1 and Test 3/4 orders, and the reversal for the refunded order.
- The CPA confirms the records are what they need.

## Stop rules

Stop and switch the pilot off (unset the two pilot variables) if any of these happen: tax is $0 where it should be
collected; the fee is not 5% or 9% as expected; a webhook delivery fails; a refund is less than the amount paid; a payout
amount differs from the record; anything is charged twice. Browsing, existing orders, refunds and payouts keep working with
checkout off.

## After the tests

Open to all verified sellers only on the owner's approval: set `MARKETPLACE_CHECKOUT_ENABLED=true` and remove the pilot
lists (docs/operations/storefront-launch-release.md, activation step 8).

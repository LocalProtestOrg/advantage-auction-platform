# First real storefront sale: pilot test plan (owner's personal Professional Seller account)

Updated 2026-11-10 (owner decision): the pilot seller is the owner's **new personal Professional Seller account**,
registered through the normal signup (docs/operations/pilot-seller-onboarding.md), and every purchase is made from a
**separate pilot buyer account**. **Lewis & Maese are not used for any live purchase, refund or payout test**, and none
of their records are changed.

Real money moves: the pilot buyer pays with a real card; Advantage.Bid absorbs the card fee the processor keeps on a
refunded payment (about 2.9% + 30 cents). Each step needs the owner's go-ahead; checkout stays OFF for everyone else.

## Prerequisites (all must be true)

| # | Requirement | How to confirm |
|---|---|---|
| P1 | Production at d38a2da or later (purchase policies + sales tax safeguard); health OK | `/api/health`; GitHub deployment |
| P2 | Legal: Terms of Service section 3A, Schedule A note, Privacy Policy amendment posted; Buyer Terms Version 4 published with the Sales Near You flag (after attorney review and owner approval) | `/buyer-terms.html` shows Version 4 with Part B |
| P3 | Sales tax: the CPA's written determination covers the **pilot seller's pickup state** (and any state a shipping test delivers to) **and the effect on auction invoices**; the rule entered in Admin > Tax Jurisdictions; the Stripe registration active if tax is collected at checkout (docs/operations/storefront-tax-configuration-steps.md) | Admin > Tax Jurisdictions shows the state; without it the safeguard refuses every order |
| P4 | Live webhook endpoint carries the payment, refund, dispute and transfer events (docs/operations/stripe-live-webhook-verification.md) | Owner checklist complete |
| P5 | Both administrator emails verified (the Admin/Finance sale notice goes only to verified addresses) | Sign in as each > `https://bid.advantage.bid/verify-email.html` > Resend Confirmation Email |
| P6 | Pilot seller onboarding complete (guide steps 1 to 13), business verification approved by an administrator | The pilot seller's readiness list: every step done except "Online checkout open" |
| P7 | Pilot buyer account created, email verified, separate from the seller and from both administrators | Account ids recorded |
| P8 | Fresh production backup taken and verified the same day | Neon branch compared with production |
| P9 | Pilot switch: `MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS=<pilot seller company id>` and `MARKETPLACE_CHECKOUT_PILOT_USER_IDS=<pilot buyer account id>`; `MARKETPLACE_CHECKOUT_ENABLED` stays unset | Only that buyer sees Buy Now, and only on the pilot seller's items |

## Inventory for the pilot (set up by the pilot seller)

| Item | Price | Quantity | Fulfillment | Used in |
|---|---|---|---|---|
| A | $20.00 | 1 | pickup | Test 2 (purchase, then full refund) |
| B | $25.00 | 3 | pickup | Test 3 (multi-quantity, 2 units from the website widget, 5%) |
| C | $30.00 | 1 | pickup | Tests 4 and 5 (kept sale: pickup, reporting period, payout) |
| D (optional) | $15.00 + flat shipping | 1 | shipping to the buyer | Test 6, only if the CPA covers the buyer's state |

Expected commissions (item price only; shipping and tax excluded): 9% Marketplace Sale, 5% Website Sale.
A: fee $1.80, proceeds $18.20. B (2 units, website): goods $50.00, fee $2.50, proceeds $47.50. C (marketplace): fee $2.70,
proceeds $27.30.

## Test 1: storefront and catalog (no money)

1. The storefront page shows the branding, about text, both policies and items A to D, publicly and in the widget on the
   external website; item B shows 3 available.
2. A visitor who is not the pilot buyer sees Contact Seller, never Buy Now.
3. **Pass when:** both channels show the same items and stock, and the seller's readiness list is complete.

## Test 2: Marketplace Sale (9%) and full refund

1. As the pilot buyer, open item A from Advantage.Bid (not the widget). Buy Now, pickup, review: the "Before you pay"
   rules, both policy links and the Buyer Terms; the sales tax line matches the CPA's determination for the pickup state
   (stop if tax should be collected and shows $0 or a refusal appears).
2. Pay with a real debit or credit card.
3. **Pass when:** Admin > Marketplace Orders shows the order paid, channel Marketplace, fee 9% ($1.80), proceeds $18.20,
   tax and remitter as configured, Buyer Terms Version 4 recorded; the item shows SOLD; the card fee is recorded within
   minutes; Stripe shows the payment and the `payment_intent.succeeded` delivery with HTTP 200.
4. **Notifications:** the seller's sale email; the buyer's receipt; the Admin/Finance sale email (both administrators);
   the owner's sale text.
5. Admin refund (reason "Pilot refund test"; who caused it: Advantage.Bid). **Pass when:** the Stripe refund equals
   everything paid (item + tax), no fee; the order shows Refunded; the buyer's refund email arrives; `charge.refunded`
   delivered with HTTP 200; the tax record is reversed. Item A is not put back on sale automatically.

## Test 3: multi-quantity and Website Sale (5%)

1. On the external website page with the widget, open item B, Buy Now (opens Advantage.Bid checkout), quantity 2, pay.
2. **Pass when:** channel Website, fee 5% ($2.50 on $50.00), proceeds $47.50, the embedding site recorded; item B shows 1
   available everywhere (widget and marketplace); the order shows quantity 2.
3. Keep this sale or refund it (owner's choice; a refund returns 2 units to the sold count but does not relist them).

## Test 4: pickup and the reporting period

1. Buy item C from Advantage.Bid (9%). The owner collects it; the pilot seller clicks Pickup Complete.
2. **Pass when:** My Purchases shows the pickup time and "report any problem by" 48 hours later; the seller's order page
   shows when the reporting period ends.
3. Optional (no money moves): the buyer reports "Damaged"; the payout is held; Admin > Storefront Moderation shows the
   report within the period; resolve it with "release the payout hold"; the order is payable again.

## Test 5: payout

1. The Thursday payout includes a sale picked up at least 48 hours before the Wednesday 11:59 PM Eastern cutoff (pickup
   by Monday evening).
2. Thursday: Admin > Storefront Payouts (`https://bid.advantage.bid/admin/storefront-payouts.html`): the prepared record
   lists item C (and item B if kept and picked up) with the proceeds.
3. Pay Seller; confirm the amount. **Pass when:** the record shows paid; Stripe shows one transfer to the pilot seller's
   connected account (`transfer.created` delivered); the deposit reaches the owner's bank.

## Test 6 (optional): shipping and destination tax

Only if the CPA's determination covers the buyer's ship-to state and that state's rule is entered. Buy item D with
shipping to the pilot buyer's address. **Pass when:** tax follows the destination state's rule (or the order is refused
before payment if that state has no rule, which is also correct); the seller ships with tracking and marks delivered; the
7-day reporting period starts at delivery.

## Isolation checks (during the pilot)

- Another seller's items still show Contact Seller to the pilot buyer; the pilot seller's items show Contact Seller to
  every other buyer.
- No other seller's orders, payouts or readiness change (Admin > Marketplace Orders lists only pilot orders).
- Lewis & Maese: no orders, no payout records, no changes.

## Stop rules

Switch the pilot off at once (unset the two pilot variables) if: tax is $0 where it should be collected, or tax appears
where the rule says none; a commission is not 9% / 5% as expected; a webhook delivery fails; a refund is less than the
amount paid; a payout differs from its record; anything is charged twice; any other seller is affected. Browsing,
existing orders, refunds and payouts keep working with checkout off.

## After the pilot

Report the results to the owner. Opening checkout to more sellers (setting `MARKETPLACE_CHECKOUT_ENABLED=true` and
removing the pilot lists) needs the owner's explicit approval.

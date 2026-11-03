# Storefront commission: Stripe costs and illustrative profitability (2026-11-03)

Owner decision 2026-11-03: Professional Storefront commission is **5%** of the item price for a sale that began in the
seller's embedded storefront on the seller's own website, **9%** for every other sale (Advantage.Bid marketplace). Card
processing is included; no subscription or listing fee. Shipping and sales tax are excluded from the commission base.

## 1. Stripe costs under this account's configuration

How the account is set up (verified in code, `src/services/marketplaceOrderService.js`, `stripeConnectService.js`):

- Advantage.Bid is the merchant of record: the buyer's card is charged on the **platform** account (PaymentIntent,
  manual confirmation), so **Advantage.Bid pays the card fee** on the whole charge (item + shipping + sales tax).
- Sellers are paid by a **separate transfer** to a Connect recipient account (Accounts v2, Express dashboard,
  `fees_collector: application`, `losses_collector: application`): **Advantage.Bid pays the Connect fees and bears
  chargeback losses** it cannot recover from the seller.
- Stripe Tax is ON in production (`STRIPE_TAX_ENABLED`), so tax calculations are billed.

**Could not be verified from this session:** the production Stripe secret key is sealed (not readable through
`railway run`), so the account's actual negotiated rates were not read. The figures below are **Stripe's standard
published US pricing** and must be confirmed in the Stripe Dashboard (Settings > Billing/Pricing, or the fee breakdown on
any recent live payment). From the first storefront sale on, the **actual** card fee of every order is recorded
automatically (`marketplace_orders.processing_fee_cents`, migration 215) and shown on Admin > Storefront Orders.

| Cost | Standard published rate (confirm) | Who pays here |
|---|---|---|
| Domestic card charge | 2.9% + $0.30 of the amount charged | Advantage.Bid |
| International card | +1.5% | Advantage.Bid |
| Stripe Tax | 0.5% of each transaction where tax is calculated | Advantage.Bid |
| Connect (platform pays) | $2 per monthly active connected account + 0.25% + $0.25 per payout to a seller's bank | Advantage.Bid |
| Transfer platform -> connected account | no separate fee (covered by the Connect pricing above) | - |
| Dispute (chargeback) | $15 per dispute (returned only in some cases if won) | Advantage.Bid, then recovered from the seller where the agreement allows |
| Refund | the original card fee is **not** returned by Stripe | Advantage.Bid |

## 2. Illustrative profitability per order (pickup, no shipping, domestic card)

Net = commission - card fee (2.9% + $0.30). "With payout" also subtracts one weekly seller payout (0.25% of the
proceeds + $0.25) and one week's share of the $2 monthly active-account fee (~$0.46), i.e. the worst case where the
order is the seller's only sale that week. "With tax" assumes 8.25% sales tax: the card fee is then on the larger total
and Stripe Tax adds 0.5%.

**5% website sale**

| Item price | Commission | Card fee | Net | Net % | With payout (1 order/week) | With 8.25% tax |
|---|---|---|---|---|---|---|
| $20 | $1.00 | $0.88 | $0.12 | 0.6% | -$0.64 | -$0.03 |
| $50 | $2.50 | $1.75 | $0.75 | 1.5% | -$0.08 | $0.38 |
| $100 | $5.00 | $3.20 | $1.80 | 1.8% | $0.85 | $1.06 |
| $500 | $25.00 | $14.80 | $10.20 | 2.0% | $8.30 | $6.50 |
| $1,000 | $50.00 | $29.30 | $20.70 | 2.1% | $17.61 | $13.31 |

**9% marketplace sale**

| Item price | Commission | Card fee | Net | Net % | With payout (1 order/week) | With 8.25% tax |
|---|---|---|---|---|---|---|
| $20 | $1.80 | $0.88 | $0.92 | 4.6% | $0.16 | $0.77 |
| $50 | $4.50 | $1.75 | $2.75 | 5.5% | $1.92 | $2.38 |
| $100 | $9.00 | $3.20 | $5.80 | 5.8% | $4.86 | $5.06 |
| $500 | $45.00 | $14.80 | $30.20 | 6.0% | $28.35 | $26.50 |
| $1,000 | $90.00 | $29.30 | $60.70 | 6.1% | $57.71 | $53.31 |

Observations (not policy changes):
1. A **5% website sale below about $14.29** does not cover the card fee alone; with a weekly payout and Stripe Tax the
   break-even rises to roughly **$50-$60** for a seller with one sale a week. The 9% rate covers card costs above ~$4.92.
2. **Shipping and sales tax are charged on the card but not in the commission base**, so they raise Advantage.Bid's cost
   without raising its commission (example: a $20 website sale with $15 shipping costs $1.32 in card fees against a $1.00
   commission).
3. Weekly batching matters: the per-payout Connect fee is per seller per week, not per order, so sellers with several
   sales a week cost much less per order than the "1 order/week" column.
4. International cards (+1.5%) take a 5% website sale on a $100 item from $1.80 to $0.30 net.

## 3. Refunds (approved policy unchanged; consequences under the new rates)

Policy as built (owner decision 2026-11-02, unchanged): refunds are administrator-controlled; before payout the order
is simply never paid out; after payout, the next payout recovers **what the seller received for that order** (the lesser
of the refund and the seller's paid amount), recorded once and released if that payout is voided.

Consequences, per fully refunded order:

| | 5% website, $100 item | 9% marketplace, $100 item |
|---|---|---|
| Buyer refunded | $100.00 | $100.00 |
| Recovered from seller (if already paid) | $95.00 | $91.00 |
| Commission returned to the buyer (Advantage.Bid keeps nothing) | $5.00 | $9.00 |
| Card fee kept by Stripe (Advantage.Bid's loss) | $3.20 | $3.20 |
| Advantage.Bid net on the order | **-$3.20** | **-$3.20** |

So under both rates a refunded sale costs Advantage.Bid the full card fee, and the commission it would have earned. The
**cash loss per refund is the same as under the old 11%** (the card fee); the commission forgone is smaller (5% or 9%
instead of 11%). A partial refund recovers proportionally up to the seller's paid amount; the commission is not
reduced, so Advantage.Bid keeps its commission on the part not refunded. A chargeback adds the $15 dispute fee.

**Decision for the owner (not implemented):** whether a seller-caused refund (item not as described, not available,
not handed over) should also recover the card fee and/or the commission from the seller. Not changed without your
authorization.

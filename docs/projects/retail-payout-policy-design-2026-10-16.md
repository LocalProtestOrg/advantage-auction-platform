# Retail (storefront Buy Now) settlement and payouts — Milestone 3 policy design (for owner approval)

Status: **planning only** (2026-10-16). No retail payout or money movement exists or will be activated until this policy
is approved and Stripe production configuration (payments, webhooks, Connect onboarding, Tax registrations) is verified.
Today `payout_eligible` is a flag and every payout is a manual decision.

## 1. Schedule (provisional, from the owner)

- Payouts run on **Thursdays** (existing Advantage.Bid schedule). Eligibility cutoff: **Wednesday 11:59 PM ET**.
- An order is **payout-eligible** no earlier than **3 calendar days after verified delivery or confirmed pickup**, provided
  the payment has cleared and nothing holds it.
- Example: picked up Saturday 2 PM → eligible from Tuesday 2 PM → paid Thursday. Delivered Monday 10 AM → eligible
  Thursday 10 AM → misses Wednesday's cutoff → paid the following Thursday.

## 2. What counts as fulfilment evidence

| Situation | Starts the 3-day clock | Notes |
|---|---|---|
| Shipped (carrier + tracking recorded) | **No** | "Shipped" is never proof of delivery (owner rule). |
| Carrier reports *Delivered* | Yes — at the carrier's delivery timestamp | Read from the carrier tracking feed (provider to be chosen); the tracking number must match the carrier recorded at shipping. |
| Delivered with signature / photo | Yes | Stronger evidence; kept with the order history. |
| Local pickup confirmed | Yes — at confirmation | Proposed: the **buyer** confirms pickup (one tap, or a pickup code shown in the buyer's order and read by the seller). Seller-only "picked up" without a buyer code → **manual review** before eligibility. |
| No delivery scan 14 days after shipping | No | Flagged for review; seller is asked for evidence. |
| Buyer reports not received after a Delivered scan | Clock stops | Issue hold (built in Milestone 2) until an admin resolves it. |

## 3. Holds (any one prevents payout until resolved)

- Open buyer issue about receipt / condition / refund (automatic, Milestone 2).
- Chargeback / payment dispute (automatic, migration 197). A lost dispute reduces or cancels the seller's proceeds.
- Payment mismatch between the processor record and the order (automatic, migration 197).
- Partial refund (proceeds must be recalculated before payout).
- Fraud concern or manual admin hold (with written reason).
- Seller payout account not verified, or changed within the last 72 hours (see staff design §4).

## 4. Refunds

- Full refund before payout → order not payable; item handling per existing rules (relist only by the seller, never automatic).
- Partial refund before payout → proceeds = item + shipping − fee recomputed on the **refunded** item amount (policy choice:
  is the 11% fee refunded proportionally to the seller? **decision needed**); sales tax reversed proportionally (already built).
- Refund **after** payout → the amount becomes a **seller balance owed**, recovered from the seller's next payouts
  (never from another seller); if not recovered within 60 days → collections decision by the owner.

## 5. Safeguards

| Risk | Safeguard |
|---|---|
| Duplicate payout | One `retail_payout_lines` row per order (UNIQUE order_id), a payout batch per seller per Thursday (UNIQUE seller_id, payout_date), processor transfers created with an idempotency key per batch; an order in a paid batch can never be added to another. |
| Paying the wrong seller | The payout line's seller is the order's seller via a composite foreign key (same pattern as migration 197); the transfer destination is the Connect account verified for that seller at batch creation and recorded on the batch. |
| Redirected payouts | Payout destination changes need owner step-up and trigger a 72-hour hold (staff design §4). |
| Reconciliation | Each Thursday: processor balance transactions ↔ payout batches ↔ order lines must match to the cent; any difference stops the batch and alerts the owner. Daily: paid orders ↔ processor charges. |
| Admin override | An admin may hold, release or exclude an order from a batch with a written reason (append-only history). An admin cannot change an order's seller, amounts or a paid batch. |
| Payout account verification | Stripe Connect Express/Standard onboarding must report payouts enabled + identity verified before a seller's first batch. |

## 6. Operational consequences

- Sellers wait at least 3 days after delivery/pickup plus up to 7 days for the next Thursday (typically 4–10 days).
- Buyer-confirmed pickup adds a step for buyers; without it, pickups need admin review (staff time).
- A carrier-tracking integration is required (cost per tracking lookup; provider choice is a decision).
- Refunds after payout create seller balances that need collection handling.

## 7. Decisions needed

1. Confirm the 3-day hold, Thursday payout and Wednesday 11:59 PM ET cutoff.
2. Pickup confirmation: buyer confirmation / pickup code (recommended), or seller confirmation with review?
3. On a partial refund, is the 11% seller fee refunded proportionally?
4. Refunds after payout: recover from future payouts (recommended) — and the 60-day collections threshold.
5. Carrier tracking provider (e.g. EasyPost, Shippo, AfterShip) and who pays per-lookup cost.
6. Stripe Connect account type (Express recommended) and whether existing auction sellers must onboard before retail payouts.

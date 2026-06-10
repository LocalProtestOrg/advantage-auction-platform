# Auction Close Runbook

**Audience:** Advantage admin/operator. **Goal:** ensure an auction closes correctly, settlement-relevant emails fire, and post-close steps are handled — within current production limits.

## How closing works
- **Per-lot soft close** with **1-minute staggered** closings. A bid in the final **≤ 2 minutes** extends that lot by **2 minutes** (`extended_until`).
- The **state-transition scheduler** inside `notificationWorker.js` performs lot auto-close and moves the auction `active → closed` once all lots are closed / `end_time` passes. (`closeAuction` accepts `active` as a valid pre-close state.)
- **Manual close (admin):** `POST /api/admin/auctions/:auctionId/close` — use only when a deliberate early/forced close is required.

## On close — what fires automatically
1. **Operational close email** to the seller (`operationalCloseEmailService`): auction total, per-buyer summary, and an **unpaid-items warning**. Sent via SES. Seller resolved through the canonical ownership chain (`auctions.seller_id → seller_profiles → users`).
2. Winners recorded per lot (`winning_buyer_user_id`, `winning_amount_cents`). **Tax is calculated after close.**
3. Buyers can now see purchased-lot details **once their payment is verified** (full address gating).

## Admin post-close steps
1. **Confirm close** in admin view / `GET /api/admin/audit-log` (state `closed`).
2. **Send the final seller report** (PDF) when ready: `POST /api/admin/auctions/:auctionId/send-final-report`.
   - Generates the auction report PDF (lots, sale prices, payout breakdown) and emails the seller via SES.
   - Verified working in production validation (reporting uses deployed `end_time`/`lot_number`).
3. **Monitor payments/unpaid lots.** Review the unpaid-items warning; follow up on unpaid winning lots.
4. **Pickup scheduling.** Communicate pickup per the seller-type pickup-gap rule (non-professional: ≥ 48h after close).

## Current production limitations (read before relying on settlement automation)
- **Stripe is in TEST mode** — no real settlement money moves. Treat totals as test data.
- **Seller payout record creation is NOT wired into the close flow** (`payoutService.createSellerPayoutRecord` exists and is correct but is not auto-invoked). Payout records are not created automatically; handle payouts manually/out-of-band during the pilot.
- **Refund / webhook settlement-integrity hardening (Line B) is NOT in production.** Avoid real refunds; escalate to engineering.
- **`missed_pickups` handling table is not present in production** (migration 008 not applied) — missed-pickup automation is unavailable; handle manually.

## Verification checklist (read-only)
- [ ] Auction state = `closed`.
- [ ] Operational close email received by seller (check SES/worker logs + seller inbox).
- [ ] Winner/total figures look correct vs bids.
- [ ] Final report PDF sent (when triggered) and received.
- [ ] Unpaid lots list reviewed.

## Escalation
- Close didn't trigger / auction stuck `active` past `end_time` → check `notificationWorker` is running (incident runbook); the scheduler drives close.
- Close/operational email failed → check SES (`POST /api/admin/email/test`), worker logs.

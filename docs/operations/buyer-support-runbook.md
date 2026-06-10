# Buyer Support Runbook

**Audience:** Advantage admin/support. **Goal:** resolve common buyer issues during the pilot without violating privacy, payment, or bidding rules.

## Buyer permissions (enforced)
Buyers have access only to: bidding, favorites/watchlist, account, notification preferences, payment methods, invoices, and **purchased-lot** details. Nothing else.

## Key facts
- **Public identity = auction-specific paddle number.** Never expose a buyer's real name/email to other users.
- **Card verification:** a temporary random charge **under $1** at signup and on card change. **Stripe is in TEST mode during the pilot** — verifications/charges are test transactions, not real money.
- Only **debit and credit cards** are accepted.
- **Buyer premium** is shown live during bidding; **tax** is calculated after auction close.
- **Full address (seller/pickup) stays hidden until the buyer's payment is verified.**
- **Soft close:** lots close on a 1-minute staggered schedule; a bid placed with **≤ 2 minutes remaining extends that lot by 2 minutes**.

## Common scenarios
### 1. "My card was declined / I see a small charge"
- The sub-$1 charge is the **card verification** (auto-reversed). In TEST mode, use Stripe **test cards** (e.g., `4242 4242 4242 4242`). Confirm in the Stripe **test** dashboard. Do not advise on real-card behavior until LIVE cutover.

### 2. "I was outbid / didn't get an outbid notice"
- Outbid notifications are queued and sent via SES (`OUTBID` type). Check the buyer's notification preferences (email on; SMS only if opted in). Verify `notifications_queue` processing in `notificationWorker` logs.

### 3. "My winning bid didn't extend the lot" / soft-close confusion
- Extension triggers only for bids in the final ≤2 minutes. Confirm bid timestamp vs the lot's `closes_at`/`extended_until`. This is expected behavior, not a bug, outside the 2-minute window.

### 4. "I can't see the pickup address"
- Expected until payment is verified. Confirm payment status; once verified, purchased-lot details (including address) become visible. (Note: address-at-rest encryption is a known pending item — see incident runbook / gaps.)

### 5. "I want to favorite/watch lots"
- Watchlist via `/api/watchlist`; buyers view favorites on their dedicated page.

### 6. Invoice / payment questions
- Invoices via `/api/invoices`. Tax is added post-close. Buyer premium is included per the published terms.

## What support MUST NOT do
- Do not reveal another buyer's identity behind a paddle number.
- Do not manually move money or issue refunds outside the platform — **refund integrity hardening is NOT yet in production** (Line B deferred). Escalate refund requests to engineering; do not improvise in Stripe.
- Do not change a buyer's role or disable accounts without cause + audit note.

## Escalation
- Payment/refund anomalies → engineering (see `production-incident-response-runbook.md`).
- Suspected fraud → admin fraud review; preserve audit trail (`/api/admin/audit-log`).

# Phone Sasha: secure payment link — design memo

**Status:** Option A APPROVED (2026-10-07) and IMPLEMENTED: src/services/payLinkService.js, GET /pay/:token (src/routes/payLink.js), the Phone Sasha tool send_payment_link, and the ?pay= hand-off on /invoices.html. Option B was not built.
**Date:** 2026-10-07
**Scope:** let a verified caller receive a text message that takes them straight to paying the right auction invoice, without Sasha ever handling card data, and without changing tax, invoice, settlement or payout behavior.

---

## 1. How payment works today (verified in code)

- At auction close each winner gets one **combined invoice** per auction (`buyer_auction_invoices`).
- The card on file is charged automatically. If that fails, the invoice shows **payment required**.
- The buyer pays from `/invoices.html` (login required). The payment runs on three authenticated routes:
  1. `POST /api/payments/charge-combined { combined_invoice_id }` → `paymentService.createCombinedPaymentIntent(userId, combinedInvoiceId, idempotencyKey)`. Returns a `payment_id` and never a client secret.
  2. `GET /api/payments/checkout/:paymentId` → `paymentService.getCheckout(userId, paymentId)`. Returns the amount, tax breakdown and labels. Only the paying buyer can load it.
  3. `POST /api/payments/checkout/:paymentId/confirm` → `paymentService.confirmOnSessionPayment(...)`. The card is confirmed server-side; prepaid cards are refused; 3-D Secure is supported.
- Settlement happens in the existing Stripe webhook (null-lot branch for combined invoices). Tax is Stripe Tax, already on the invoice.
- `/payment.html` is the existing card page. It is the only place card details are entered, by the buyer, into Stripe Elements.

**Conclusion:** a payment link only needs to deliver the buyer to that existing flow, with the right invoice selected. It needs no new Stripe object, no Checkout Session, and no change to how the amount, tax, invoice or settlement are computed.

---

## 2. Recommended design

### 2.1 The flow

1. Caller verifies (4-digit code to the verified mobile on file, or to the account email). A phone session exists.
2. Caller: "I want to pay my invoice."
3. Sasha calls `get_my_invoices`. If several are payable, she asks which one, by auction name and amount.
4. Sasha calls a new tool, **`send_payment_link({ invoice_number })`**.
5. **Railway decides eligibility** (Sasha cannot override it). All of the following must hold:
   - the phone session is live, and the invoice belongs to the session's user;
   - the invoice status is `payment_required` (or `issued` with a failed charge). Paid, void and refunded invoices are refused;
   - the auction is not a pre-launch test or demo;
   - the account is active and not demo or suspended;
   - no other live link exists for this invoice (a new one replaces it);
   - rate limits pass: at most 3 links per invoice per day and 5 per account per day.
6. Railway creates a **payment link token**:
   - 32 random bytes, sent in the text message;
   - only its **SHA-256 hash** is stored, in a new table `payment_links`, bound to `user_id`, `combined_invoice_id`, the amount due at issue, `call_id`, `phone_session_id`, `expires_at` (30 min) and `used_at`.
7. Railway texts the link **to the phone number on file only**: `https://bid.advantage.bid/pay/<token>`. The message reads: "Advantage.Bid: pay invoice INV-… for Henderson Estate ($312.50): <link>. Expires in 30 minutes."
8. Sasha says the link was texted to the number ending in 1234. She never reads it aloud and never asks for card details.

### 2.2 What happens when the link is opened (`GET /pay/:token`)

- Railway hashes the token and looks it up. Unknown, expired, used, or a mismatched invoice all get the **same** "This link has expired" page, with a link to sign in.
- **Authentication at the destination (recommended: Option A).** The link proves *which invoice*, not *who you are*.
  - If the browser already has a session for **the same user**, go straight to `/payment.html` for that invoice.
  - Otherwise, show the normal sign-in page (forgot-password available) with `next=` set to the payment page for that invoice. After sign-in, the session user must equal the link's `user_id`; otherwise refuse.
- The token is marked `used_at` when the payment page loads for the right user (single use). Reloading the payment page then works through the normal session, as today.
- Payment then runs **unchanged** through `charge-combined → checkout → confirm`. Amount, tax, invoice settlement, seller settlement and payout code are untouched.

### 2.3 Option B (not recommended for launch)

- Here the token itself grants a 15-minute "payment-only" session, limited to the three payment routes for that one invoice, with no login.
- It is lower friction for callers who don't know their password.
- It also creates a new authentication path that must be locked down (route allow-list, no account pages, no card-management pages). It would be the first bearer credential that substitutes for a login.
- Revisit only if Option A's sign-in friction proves to be a real problem in practice.

### 2.4 After payment

- The existing webhook settles the invoice and sends the existing pickup/success-package email (with the pickup address, as today).
- On the phone (if the caller is still on the line), Sasha's `get_my_invoices` simply shows "paid" on the next lookup. No new notification path.
- `payment_links.paid_at` is filled by a small read-only reconciliation (invoice paid after link issued), for reporting only.

---

## 3. Audit trail

The existing `cs_phone_audit` table records the following. Each row stores references only: invoice number, last 4 digits of the destination, call and session ids. Never the token or the URL.

| Event | Meaning |
|---|---|
| `payment_link_requested` | Sasha asked |
| `payment_link_refused` | Not eligible, with the reason |
| `payment_link_sent` | Text accepted by the SMS provider |
| `payment_link_opened` | Valid open |
| `payment_link_rejected` | Expired, used or wrong user |
| `payment_link_consumed` | Payment page loaded for the right user |

Payment success is already audited by the payment and webhook system.

---

## 4. SMS delivery

- Real texts need, all together:
  - the phone channel enabled;
  - an SMS sender that is not Verify (Verify is only for codes);
  - an **A2P 10DLC campaign whose use case covers customer-care / account-notification texts with links**, or a verified toll-free number.
- The repo shows no documentation of which use cases the current campaign covers. **Ty needs to confirm this in the Twilio console.**
- The message goes only to the account's phone on file, never to the caller ID. STOP/HELP keywords need an inbound SMS webhook (not built).
- If texting is unavailable, Sasha offers the alternative: "sign in at bid.advantage.bid and open Invoices", or a team callback.

---

## 5. Threat model

| Threat | Mitigation |
|---|---|
| Caller impersonates the account holder | Code to the phone on file before any account access; caller ID never trusted; lockouts. |
| Link forwarded or intercepted (SMS) | Option A: the link alone cannot pay or see anything without the account's login. 30-minute expiry, single use. |
| Link guessed or enumerated | 256-bit random token; hash-only storage; identical response for every invalid case; rate limit on `/pay/*`. |
| Replay | `used_at` set on first valid use; later opens get "expired"; a new link replaces the old one. |
| Wrong invoice or amount | Link bound to `combined_invoice_id`. The amount is always recomputed server-side by the existing checkout; the link never carries an amount. |
| Already paid / refunded | Eligibility re-checked at send and at open; the existing checkout also refuses a paid invoice. |
| Card data spoken on the call | Redacted before storage and before the model (built in this release); Sasha interrupts and redirects. |
| Phishing look-alikes | Fixed sender, fixed wording, our domain only. Sasha never sends links on request to other numbers. |
| Tax / settlement drift | No change to payment, tax or webhook code. Link → login → the same three routes used today. |
| Staff misuse | Only Sasha (verified session) creates links; Super Admin simulations use the simulated handset; all audited. |

---

## 6. What would be built (after approval)

- Migration: a `payment_links` table (hash, user, combined invoice, amount at issue, call, session, expires, used, paid, created).
- Service: `paymentLinkService.issue()` / `open()` / `consume()`, plus eligibility checks reusing invoice status (no new money logic).
- Route `GET /pay/:token` → redirect to sign-in or `/payment.html?invoice=…`. `payment.html` would need a tiny change to accept the invoice parameter and call the existing `charge-combined`.
- Phone tool `send_payment_link`, verified sessions only, audited.
- Tests:
  - eligibility (paid, void, refunded, other user's invoice, demo);
  - expiry, single use, replay;
  - wrong-user sign-in, rate limits, no token in logs or audit;
  - an unchanged checkout amount and tax compared with the existing route.

**Not changed:** Stripe objects, amounts, tax, invoice generation, settlement, payouts, buyer premium, card verification.

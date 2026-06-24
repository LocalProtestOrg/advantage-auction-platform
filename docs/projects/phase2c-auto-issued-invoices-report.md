# Phase 2C — Auto-Issued Unpaid Invoices + Invoice Ops Hardening — Staging Report

**Status:** Implemented and validated on **staging only**. No production deployment. No Stripe LIVE, no buyer-premium activation, no tax change, no seller-settlement work, **no payment-capture or payout change** — this is invoice *generation* only.
**Date:** 2026-06-24
**Branch:** `feat/phase2-invoice-system` (Phase 2C on top of 2A/2B).
**Staging:** `advantage-staging` (Neon `ep-royal-dawn-anarou3f`), `https://advantage-staging-production.up.railway.app`. Migration **073** applied. Deployed via `railway up --service advantage-staging`.

> Goal: every winning buyer has an invoice — paid or unpaid — so the pickup packet covers all winners, not just buyers who already paid.

---

## 1. Architecture

### 1.1 Invoice lifecycle (the core change)
Invoices are now keyed by the natural pair **`(lot_id, buyer_user_id)`** (a lot has one winner). Migration **073**:
- Makes `invoices.payment_id` **nullable** (an invoice can exist before any payment).
- Adds **`UNIQUE (lot_id, buyer_user_id)`** (with a one-time dedup guard) — the anchor for idempotent create and stable upsert.

Two invoice operations (`invoiceService`):
- **`createIssuedInvoice(...)`** — `INSERT … ON CONFLICT (lot_id,buyer_user_id) DO NOTHING`. Creates an **unpaid `issued`** invoice; idempotent (returns a row only when newly inserted).
- **`createInvoice(payment)`** (the paid path, called by `recordPaymentSuccess`) — `INSERT … ON CONFLICT (lot_id,buyer_user_id) DO UPDATE SET status='paid', payment_id=…`. If an `issued` invoice exists it is **promoted in place to `paid`**, linking the payment and **keeping the existing `invoice_number`** (the number is not in the `SET` list). No duplicate row.

### 1.2 Auto-issue at close — **POST-COMMIT, best-effort, decoupled**
`auctionService.closeAuction` determines winners inside its transaction, then — **after `COMMIT`** — calls `invoiceService.issueInvoicesForAuctionWinners(auctionId)` (fire-and-forget) and emails each newly-created unpaid invoice. This is **deliberately outside the close transaction** so an invoice or email failure can **never roll back the auction close** (consistent with the other post-commit steps: reporting, billing preview, operational email). It is **idempotent** — if a buyer paid in the interim, the `ON CONFLICT DO NOTHING` is a no-op and no unpaid email is sent.

### 1.3 Repair / retry path (addresses the post-commit-failure risk)
Because auto-issue is best-effort, a crash/interruption right after `COMMIT` could leave some winners without invoices. **`POST /api/admin/auctions/:auctionId/issue-invoices`** re-runs the **same idempotent** `issueInvoicesForAuctionWinners` helper (reads committed winning lots; creates only the missing invoices; emails only the newly-created ones unless `?send_email=false`). It is safe to run any number of times. The "Issue missing invoices" button in the admin Invoices panel calls it. **This is the admin repair path for failed/partial close-time generation.**

### 1.4 Emails
- **Unpaid invoice email** (`receiptService.sendUnpaidInvoiceEmail`) — sent at close per winner and on admin resend; states **"Payment must be confirmed before items can be picked up or released,"** with the invoice PDF attached. Same Amazon SES transport as all other mail; best-effort.
- **Paid receipt** (`sendPaymentReceipt`) — unchanged; still fires after payment success (now finds the upserted paid invoice by `payment_id`).

---

## 2. Files changed
- `db/migrations/073_invoice_lifecycle.sql` — payment_id nullable + dedup + `UNIQUE(lot_id,buyer_user_id)`.
- `src/services/invoiceService.js` — `createIssuedInvoice`, paid-upsert `createInvoice`, `issueInvoicesForAuctionWinners`.
- `src/services/auctionService.js` — post-commit auto-issue + unpaid-email dispatch (best-effort).
- `src/services/receiptService.js` — `sendUnpaidInvoiceEmail` + `buildUnpaidInvoiceEmail`.
- `src/routes/admin.js` — `GET /auctions/:id/invoices` (filter), `POST /auctions/:id/issue-invoices` (repair), `POST /invoices/:id/resend-invoice-email`, `POST /invoices/:id/resend-receipt`.
- `public/admin/moderation.html` — per-auction **Invoices** panel (filter paid/unpaid, PDF download, resend invoice/receipt, issue-missing).
- `scripts/stg-migrate-073.js`, `scripts/stg-validate-phase2c.js`.

---

## 3. Validation Results

### 3.1 In-process (real close + payments against staging DB) — **PASS**
`scripts/stg-validate-phase2c.js`: built an auction (existing seller_profile, 6 lots, 6 winning bids across distinct last names, 2 with thumbnails), ran the **real `auctionService.closeAuction`**, then paid 3 winners.

| Check | Result |
|---|---|
| Close created issued invoices for all winners | 6 winners → **6 issued invoices**; repair helper afterward reports **created=0** (proves close created them) ✓ |
| Issued invoices are unpaid + unlinked | all `status='issued'`, all `payment_id IS NULL` ✓ |
| Payment success **updates** the existing invoice (no duplicate) | after paying 3: **still 6 invoices total**; paid rows `status='paid'` + `payment_id` linked ✓ |
| Invoice number stable across issued→paid | paid invoices kept their original `invoice_number` ✓ |
| No duplicate invoices | `GROUP BY (lot_id,buyer_user_id) HAVING count>1` → **none** ✓ |
| Receipt email on payment | sent — messageId `<b1696042…@advantage.bid>` ✓ |
| Unpaid invoice email | sent — messageId `<27939574…@advantage.bid>` ✓ |
| Packet includes all winners | total **6** (3 unpaid + 3 paid) ✓ |
| Packet ordering | unpaid first **Adams, Diaz, Nguyen**, then paid **Brooks, Khan, Wallace**; valid PDF ✓ |

### 3.2 Live admin access control (deployed staging build) — **PASS**
Deployed via `railway up`; new build confirmed live (routes return 401 unauthenticated, not 404).

| Caller | Expected | Result |
|---|---|---|
| Admin JWT — GET invoices | 200 + counts | **200**, `counts {total:6, paid:3, unpaid:3}` ✓ |
| Buyer JWT — GET invoices | 403 | **403** `Forbidden: insufficient permissions` ✓ |
| No token — GET invoices | 401 | **401** `Authentication required` ✓ |
| Admin JWT — POST issue-invoices (idempotent) | 200, created=0 | **200** `created:0, already_existed:6` (idempotent repair over HTTP) ✓ |
| Buyer JWT — POST issue-invoices | 403 | **403** ✓ |

**Admin-only access enforced on all Phase 2C endpoints; buyers cannot reach them.**

---

## 4. Risks
1. **Auto-issue is post-commit/best-effort, NOT transactional with close.** Chosen deliberately so invoice/email problems can never block or roll back an auction close. **Mitigation:** the idempotent admin repair endpoint (`POST …/issue-invoices`) + button re-creates any missing invoices at any time; the helper reads committed winning lots, so it always converges. **Recommendation for prod:** after close, an operator (or a scheduled sweep) can hit "Issue missing invoices" to guarantee coverage; consider a periodic reconciliation job that runs it for recently-closed auctions.
2. **Close-time email volume.** One unpaid-invoice email per winner is dispatched at close (fire-and-forget, each generating a PDF). Fine at validation scale; for very large auctions consider batching or moving these into the retrying `notifications_queue`. Failures are logged and never affect the close.
3. **Migration dedup deletes duplicate invoice rows** per `(lot_id,buyer_user_id)` before adding the unique index. No legitimate duplicates should exist (one winner per lot). **Before prod promotion, verify zero real duplicates** on the prod DB (the dedup keeps the paid/earliest row).
4. **Manual mark-paid intentionally NOT implemented.** Marking an invoice paid without a captured payment would misrepresent settlement and risk releasing goods without funds. Documented as future work (see §5). The existing `POST /api/admin/payments/:id/record-success` remains the only "mark paid" path and is tied to a real payment row.

---

## 5. Open items / future work
- **Periodic reconciliation sweep** that runs `issueInvoicesForAuctionWinners` for recently-closed auctions (belt-and-suspenders for the post-commit best-effort model).
- **Move close-time invoice emails into the retry queue** (`notifications_queue`) for delivery guarantees + backoff.
- **Manual mark-paid (future, risk-reviewed):** only with an explicit "offline/manual payment" record + audit trail, never a silent status flip; keep it distinct from card capture.
- **Consolidated per-buyer invoice** (multiple lots → one invoice/sheet) — carried over from Phase 2/2B.

---

## 6. Production-readiness recommendation
The invoice-lifecycle change (auto-issue + stable paid upsert + repair path) is **low-risk and additive**: it does not touch charging, capture, or payout, and every operation is idempotent. It is **recommended for production promotion** after: (a) confirming no duplicate `(lot_id,buyer_user_id)` invoices exist on the prod DB before migration 073, (b) a brief operator UAT of the admin Invoices panel, and (c) deciding the close-time email volume policy (send-all vs. queue). Promotion should follow the standard path (migration 073 via a prod-guarded runner, then deploy) — **not performed here**.

**No production deployment. Stopping after deployed staging validation, awaiting review.**

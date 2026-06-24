# Phase 2D — Invoice Ops Polish, Reconciliation & Production Readiness — Staging Report

**Status:** Implemented and validated on **staging only**. No production deployment. No Stripe LIVE, no buyer-premium, no sales-tax, no seller-settlement, **no payout change, no manual mark-paid** (mark-paid only ever happens with real paid-payment evidence).
**Date:** 2026-06-24
**Branch:** `feat/phase2-invoice-system`. **No new migration** (reconciliation uses existing columns).
**Staging:** `advantage-staging` (Neon `ep-royal-dawn-anarou3f`), deployed via `railway up --service advantage-staging`.

---

## 1. What changed

### Reconciliation (Requirement 1) — `src/services/invoiceReconciliationService.js`
- **`checkAuction(auctionId)` — READ-ONLY.** Categorizes: winning lots without invoice; duplicate invoices; **paid payment but invoice not marked paid**; paid payment without invoice; invoices missing buyer / lot / number; invoices with no PDF generated. Returns per-category counts + sample rows, `clean`, `safely_repairable`, `needs_manual_review`.
- **`repairAuction(auctionId)` — SAFE fixes only:** (a) issue missing invoices (idempotent generation, no charge, no email), (b) regenerate missing PDFs, (c) **promote to paid ONLY where a real `payments.status='paid'` row exists** (links that payment). It **never creates payments** and **never marks paid without payment evidence**. Duplicates / missing-buyer / missing-lot / missing-number are **reported for manual review, never auto-mutated**.
- Endpoints (admin-only): `GET /api/admin/auctions/:id/invoice-reconciliation`, `POST …/invoice-reconciliation/repair`.

### Email reliability (Requirement 2)
- **Current behavior:** invoice + receipt emails are **direct best-effort sends** over Amazon SES (not queued). Failures are logged and never block close/payment.
- **Added visibility (this phase):** every send now writes an `audit_log` row — `invoice.email_sent|skipped|failed`, `receipt.email_sent|skipped|failed` (with `to`, `messageId`, `reason`) — visible via `GET /api/admin/audit-log`.
- **Recommendation (next step, not done here):** migrate invoice/receipt emails into the retrying `notifications_queue` for backoff + delivery guarantees. This needs the worker extended to render invoice/receipt bodies + attach the PDF at send time (moderate change to `notificationWorker`), so it is deferred to keep Phase 2D low-risk. See Open Issues.

### Admin UI polish (Requirement 3) — `public/admin/moderation.html` + `public/admin/index.html`
The per-auction **Invoices** panel now shows a **summary bar**: total / paid / unpaid counts **and** total **hammer**, **paid**, and **unpaid** amounts (from the extended `GET …/invoices` which now returns `totals`). Actions are explicit: **Download PDF** (per invoice), **Resend invoice**, **Resend receipt**, **Issue missing invoices**, **Pickup packet**, and **Reconcile** (inline read-only check with a **Run safe repair** button when safely-repairable issues exist).

**Discoverability (added for production):** the admin home (`/admin/index.html`) now has a top-level **"Auction Invoices"** card → `/admin/moderation.html?tab=auctions`, and `moderation.html` honors `?tab=` so the link lands directly on the **Auctions** tab where each auction's **Invoices** button lives. Verified live on staging: `https://advantage-staging-production.up.railway.app/admin/` → "Auction Invoices", and `…/admin/moderation.html?tab=auctions` opens the Auctions tab.

---

## 2. Reconciliation behavior (summary)
| Category | Detection | Repair |
|---|---|---|
| Winning lot w/o invoice | winner lot has no `(lot_id,buyer)` invoice | **issue** (idempotent) |
| Paid payment, invoice not paid | `payments.paid` but invoice `status<>'paid'` | **promote to paid** (link real payment) |
| Paid payment, no invoice | `payments.paid`, no invoice row | **create paid invoice** from the real payment |
| Invoice PDF not generated | `pdf_generated_at IS NULL` | **regenerate PDF** |
| Duplicate invoices | >1 per `(lot_id,buyer)` | **report only** (manual) |
| Missing buyer / lot / number | null/orphaned | **report only** (manual) |

Mark-paid is **only** ever a promotion backed by an existing paid payment — no fake payments, no evidence-free status flips.

## 3. Email reliability status
Best-effort direct SES sends, now **observable** via `audit_log`. Validated send outcomes return real SES `messageId`s. Queue migration recommended as the next hardening step (see §6).

---

## 4. Validation Results

### 4.1 In-process (real close + payments + reconciliation, staging DB) — **PASS**
`scripts/stg-validate-phase2d.js`: auction with **5 winners**, 2 paid normally.

| Check | Result |
|---|---|
| Auto-issue at close | 5 winners → **5 issued invoices** ✓ |
| **Scenario A** — delete an invoice | check flags **winning_lots_without_invoice=1** → repair **re-issues** → **0 missing** after; row exists ✓ |
| **Scenario B** — real paid payment, invoice still issued | check flags **paid_payment_invoice_not_paid=1** → repair **promotes to paid** (payment linked), **invoice number stable** ✓ |
| Final reconciliation | **clean** (all 8 categories 0) ✓ |
| Buyer history | unpaid buyer shows `issued`, paid buyer shows `paid`, all have invoice numbers ✓ |
| Pickup packet | 2 unpaid first + 3 paid, alphabetical, valid PDF ✓ |

### 4.2 Live (deployed staging build) — **PASS**
Deployed via `railway up`; new build confirmed live (routes 401 unauthenticated, not 404).

| Check | Expected | Result |
|---|---|---|
| GET reconciliation — admin | 200 | **200** (`clean:true`) ✓ |
| GET reconciliation — buyer | 403 | **403** ✓ |
| GET reconciliation — no token | 401 | **401** ✓ |
| POST repair — admin | 200 | **200** ✓ |
| POST repair — buyer | 403 | **403** ✓ |
| GET invoices — admin returns `totals` | 200 + totals | **200**, `totals {hammer:22500, paid:14500, unpaid:8000}` ✓ |
| Buyer downloads OWN invoice PDF | 200 | **200** ✓ |
| Buyer downloads ANOTHER buyer's invoice | 403 | **403** (ownership enforced) ✓ |

### 4.3 Pickup packet final check (Requirement 4)
Confirmed in 4.1: all winners included, unpaid first, paid second, alphabetical, valid PDF, thumbnails embed (Cloudinary JPEG fetched). **Manual grayscale UAT note:** before production sign-off, print one packet page (or use the browser's grayscale/print preview) to confirm the **UNPAID** banner remains unmistakable in black-and-white — it is built from red fill + a 3.5pt solid black border + 38pt bold white text, which renders as a heavy-bordered dark band in monochrome, but a physical print check is recommended.

### 4.4 Buyer experience (Requirement 5)
Confirmed in 4.1: buyer invoice history returns **unpaid `issued`** and **paid** invoices with stable numbers and status; PDF download works (per-invoice endpoint with ownership enforcement — live buyer-ownership checks in 4.2).

---

## 5. Production Readiness Checklist — Phase 2 invoice system (2 / 2B / 2C / 2D)
- [ ] **Migrations to apply (in order):** `072_invoice_documents.sql` (invoice number/breakdown + `generated_documents`), `073_invoice_lifecycle.sql` (payment_id nullable + `UNIQUE(lot_id,buyer_user_id)` + dedup). 2A/2D add no further migrations.
- [ ] **Database backup** (Neon branch/snapshot) taken immediately before applying 072/073.
- [ ] **Duplicate invoice preflight (critical for 073):** run `SELECT lot_id, buyer_user_id, count(*) FROM invoices GROUP BY 1,2 HAVING count(*)>1` on prod. Expect **zero**. If any exist, review before 073 (its dedup keeps the paid/earliest row).
- [ ] **Stripe TEST confirmed** on prod (no `sk_live`); this phase changes no charging/capture/payout.
- [ ] **SES confirmed** (SMTP_* + verified `EMAIL_FROM`); send a test invoice/receipt and confirm `audit_log` `*.email_sent`.
- [ ] **Apply migrations via prod-guarded runners** (mirror `stg-migrate-072/073`, prod endpoint `ep-proud-leaf-an8pzkib`), then deploy.
- [ ] **Admin UAT:** from the admin home, open the **"Auction Invoices"** card (lands on the Auctions tab) → open an auction's **Invoices** panel → counts+totals shown; download a PDF; resend invoice + receipt (verify in `audit_log`); run **Reconcile** (clean); delete a test invoice → Reconcile flags it → **Run safe repair** re-issues; download **Pickup packet** and grayscale-print check.
- [ ] **Buyer UAT:** as a buyer with an unpaid + a paid invoice, view `/invoices.html` (statuses + numbers), download both PDFs; confirm a buyer **cannot** download another buyer's invoice (403) and **cannot** hit admin invoice/packet endpoints (403).
- [ ] **Rollback notes:** code rollback = redeploy the prior build (revert the branch). Schema: 073 is additive (nullable + index); if rollback needed, drop `idx_invoices_lot_buyer` and (optionally) re-impose `payment_id NOT NULL` only after confirming no NULL rows — **but** issued invoices intentionally have NULL `payment_id`, so prefer **forward-fix** over reverting 073. `generated_documents` and invoice columns from 072 are additive and safe to leave. Keep the pre-migration Neon backup for restore-in-place if required.

---

## 6. Open issues
1. **Email queue migration (recommended next):** move invoice/receipt emails into `notifications_queue` for retry/backoff; today they are best-effort with `audit_log` visibility.
2. **Periodic reconciliation sweep:** schedule `repairAuction` (or at least `checkAuction` alerting) for recently-closed auctions, complementing the post-commit best-effort issue + the manual admin reconcile.
3. **Close-time email volume:** one unpaid email per winner at close; fine at current scale, batch/queue for very large auctions.
4. **Manual mark-paid (no payment):** still intentionally not implemented; only payment-evidence-backed promotion exists.
5. **Consolidated per-buyer invoice** (multi-lot → one sheet): carried from earlier phases.

---

## 7. Recommendation
The Phase 2 invoice system (2/2B/2C/2D) is **functionally complete and validated on deployed staging**, is **additive and low-risk** (no charging/capture/payout/tax/settlement changes; every operation idempotent; mark-paid only with real payment evidence), and now includes operator reconciliation + repair, email visibility, and a polished admin panel.

**Recommendation: READY for production deployment**, subject to the §5 checklist — in particular the **duplicate-invoice preflight before migration 073**, a **DB backup**, and **admin + buyer UAT**. The only material follow-up (email queue migration) is a reliability enhancement, not a blocker, given the new `audit_log` visibility and the reconciliation/repair safety net.

**No production deployment performed. Stopping after deployed staging validation, awaiting review/approval to promote.**

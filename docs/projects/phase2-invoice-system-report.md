# Phase 2 — Invoice, Receipt & Document System — Staging Report

**Status:** Implemented and validated on **staging only**. No production deployment. No Stripe LIVE. No Buyer Premium activation. No tax-collection behavior change.
**Date:** 2026-06-24
**Branch / commit:** `feat/phase2-invoice-system` → fast-forwarded onto `deploy/seller-studio-1b` (staging) at `229b467`.
**Staging:** Railway service `advantage-staging` (Neon endpoint `ep-royal-dawn-anarou3f`), URL `https://advantage-staging-production.up.railway.app`.
**Migration applied on staging:** `072_invoice_documents.sql` (070 + 071 already present).

> Phase 2 is the **document foundation** for the later phases (sales tax, buyer premium, seller settlements, accounting). It is intentionally additive: buyer premium, sales tax, and shipping are persisted as `0` and rendered as "—", so activating them later is a data change, not a template change. Buyers are still charged hammer only.

---

## 1. Architecture

### 1.1 Data model (migration 072)
**`invoices`** gained:
- `invoice_number` — human-readable, `AAC-NNNNNN`, assigned by a `DEFAULT` on a dedicated `invoice_number_seq` (race-free, no app dependency). Existing rows were backfilled in chronological order; a unique index enforces uniqueness.
- `invoice_date` (defaults `now()`; backfilled from `created_at`).
- Breakdown: `hammer_cents`, `buyer_premium_cents` (0), `sales_tax_cents` (0), `shipping_cents` (0), `total_cents`. Today `hammer == total == amount_cents`.
- Document stamp: `pdf_public_id`, `pdf_sha256`, `pdf_generated_at`.

**`generated_documents`** (new, reusable registry): one row per generated PDF artifact, discriminated by `doc_type` (`buyer_invoice` today; `seller_settlement` later). Columns: `doc_type, entity_type, entity_id, related_user_id, file_name, pdf_public_id, pdf_sha256, byte_size, created_at`. This is the **settlement-history foundation** — seller settlement PDFs will write the same table with `doc_type='seller_settlement'`.

All changes are additive and reversible; the live flat-10% payout and hammer-only charge are untouched.

### 1.2 Services
- **`documentService.js`** — the reusable foundation:
  - `renderPdf(drawFn, opts)` — owns PDFKit document lifecycle, returns a complete buffer.
  - `drawBrandHeader(doc, {docTitle, docSubtitle})` — consistent AAC wordmark + titled rule, shared by invoices and future settlement docs.
  - `fetchImageBuffer(url)` — dependency-free https/http image fetch with timeout + size cap; returns `null` on any problem (so rendering degrades to a placeholder, never breaks).
  - `storePrivatePdf({folder, publicId, buffer})` — **best-effort** private Cloudinary archival + SHA-256; returns `{public_id, sha256, stored}`. If Cloudinary is unconfigured it still returns the hash and the PDF path continues.
  - `signedUrl(publicId, ttl)` — 5-minute signed download URL for the private asset.
  - `recordDocument(...)` — inserts a `generated_documents` history row (best-effort).
- **`invoicePdfService.js`** — `getInvoiceData(invoiceId)` (joins invoice + lot + auction + buyer + payment + first lot image), `buildInvoicePdf(data)` (professional layout), and `generateAndStoreInvoicePdf(invoiceId)` (build → archive → record → stamp `invoices.pdf_*`).
- **`receiptService.js`** — `sendPaymentReceipt(paymentId)`: renders + archives the invoice PDF, composes an itemized HTML/text receipt, and sends via the existing Amazon SES transport (`emailService.sendEmail`) with the PDF attached. Best-effort and idempotent-friendly.
- **`invoiceService.createInvoice`** — now persists the hammer/total breakdown on creation (premium/tax/shipping = 0).

### 1.3 Wiring
- The receipt is fired **fire-and-forget after commit** inside `paymentService.recordPaymentSuccess` (post-commit block, alongside `PAYMENT_CONFIRMED`/`PICKUP_SCHEDULED`), so a delivery problem can never roll back or block a settled payment.

### 1.4 API
- `GET /api/invoices/mine` and `/api/me/invoices` (shared `fetchInvoicesForBuyer`) now return `invoice_number, invoice_date, auction_title, lot_number, total/hammer/premium/tax/shipping cents, payment_status/date, lot thumbnail`.
- `GET /api/invoices/:invoiceId/pdf` (new) — auth + ownership (invoice's buyer or admin), streams a freshly rendered PDF (`Content-Disposition: attachment`).

### 1.5 Buyer UI
- `public/invoices.html` — history table now shows Invoice #, date, auction, lot (#+title), total, status, and a **Download** button (authenticated blob fetch → client download; no token in URL).
- `public/dashboard/invoice.html` — detail page shows invoice number, auction, the full summary breakdown (hammer / premium / tax / shipping / total), and a **Download PDF** button.

### 1.6 Invoice PDF layout
AAC branded header (wordmark + `INVOICE` + invoice number) · Billed-to (buyer name/email) + invoice facts (date, auction, payment status, payment date) · Lot table (thumbnail | lot # | description | hammer) with a graceful "No image" placeholder when a thumbnail can't be embedded · Right-aligned summary (hammer subtotal, buyer premium, sales tax, shipping, **Total**) · Footer disclosure. The lot table iterates an array, so consolidated multi-lot invoices later need no template change.

---

## 2. Test Results

### 2.1 Migration (staging)
| Migration | Result |
|---|---|
| 070 seller_agreement_gate | already recorded — verify PASS |
| 071 verification_documents | already recorded — verify PASS |
| **072 invoice_documents** | **APPLIED + verify PASS** — `generated_documents` ✓, `invoice_number_seq` ✓, 10 new invoice columns ✓, 0 unnumbered invoices ✓ |

### 2.2 End-to-end validation (`scripts/stg-validate-phase2.js`, staging DB/SES/Cloudinary)
A real fixture (closed auction → lot with a real Cloudinary JPEG → winning buyer → paid payment) driven through the **actual settlement path**. The real `recordPaymentSuccess` path executed (not the fallback). **RESULT: PASS.**

| Check | Evidence |
|---|---|
| Invoice generation | `AAC-000009`, status `paid`, hammer `42500`, premium/tax/shipping `0`, total `42500` |
| Numbering + breakdown | sequence-assigned number; total == hammer == amount |
| PDF generation | valid `%PDF-`, **112,348 bytes** |
| Thumbnail rendering | Cloudinary JPEG fetched (109,669 bytes) and **embedded** (not placeholder) |
| Email delivery (SES) | **sent**, messageId `<c07bee0b-…@advantage.bid>` (two sends — async hook + explicit — both accepted by SES) |
| Document history | `generated_documents` row: `doc_type=buyer_invoice`, sha256 `b564ef49…`, 112,348 bytes, `pdf_public_id=invoices/invoice-7d6b29fd…` |
| Invoice PDF stamp | `invoices.pdf_sha256` matches history (`b564ef49…`), `pdf_generated_at` set, `pdf_public_id` set |
| Account history enrichment | `/mine` returns invoice number, auction title, lot #1, lot title, total `42500`, status `paid`, thumbnail present |
| Receipt hook fires on settlement | `recordPaymentSuccess` real path succeeded and dispatched the async receipt (log: "created invoice … / Sent Payment receipt") |

### 2.3 Live HTTP download (deployed staging build) — CONFIRMED ✓
After the Railway resource limit was lifted, the working tree was deployed to `advantage-staging` via `railway up --service advantage-staging` (deployed source `d1df7ba`, i.e. `229b467`+). New build confirmed live (the new route returns `401` unauthenticated, not `404 Route not found`). A fresh end-to-end validation run produced invoice `AAC-000010`, and the **live deployed endpoint** was exercised:

| Live check | Result |
|---|---|
| `GET /api/invoices/:id/pdf` (valid buyer JWT) | **HTTP 200** |
| Content-Type | `application/pdf` |
| Content-Disposition | `attachment; filename="invoice-AAC-000010.pdf"` |
| Body | valid `%PDF-`, **283,828 bytes** (thumbnail embedded) |
| Same endpoint, **no token** (auth/ownership) | **HTTP 401** |

The live deployed download now matches the in-process validation in §2.2. **All Phase 2 acceptance checks pass on staging.**

> Earlier blocker (now resolved, kept for the record): staging had been frozen on a `2026-06-18` build because the git push to `deploy/seller-studio-1b` did not trigger a rebuild, and `railway up` was initially rejected with "You have used all your available resources." Both were cleared (Railway limit lifted + auto-deploy enabled), and the `railway up` deploy succeeded.

---

## 3. Screenshots / Visual Verification

Automated browser screenshots were **not** captured in this run (no headless browser/Playwright session was driven). Instead, visual artifacts were verified by their concrete properties:
- **Invoice PDF:** a valid 112 KB PDF was produced and archived (sha256 `b564ef49…`); the operator received the itemized receipt with the PDF attached at `advantageauction.bid+phase2val@gmail.com` (Gmail plus-addressed to the operator inbox) — open that email to visually confirm the rendered invoice and attachment.

**Manual screenshot checklist (recommended before sign-off), logged in as the validation buyer on staging:**
1. `/invoices.html` — history table with Invoice #, auction, lot, total, status, Download button.
2. Click **Download** → invoice PDF opens/downloads (branded header, lot thumbnail, summary, Total).
3. `/dashboard/invoice.html?id=<invoice>` — detail with breakdown + Download PDF.
4. The receipt email in the operator inbox (itemized body + PDF attachment).

---

## 4. Open Issues / Notes

1. **Staging deploy — RESOLVED.** The earlier freeze (git push not rebuilding + Railway resource limit) was cleared; `railway up --service advantage-staging` deployed `229b467`+ and the live endpoint check (§2.3) now passes. Note for the future: confirm whether git-push auto-deploy for `deploy/seller-studio-1b` is reliably firing, or standardize on `railway up --service advantage-staging` for staging deploys.
2. **Per-lot invoices (not consolidated).** Today one invoice == one lot (the payment model is per-lot). A multi-lot winner receives multiple numbered invoices/receipts. The PDF/template already supports N lot rows; consolidation is a future, separate change (and pairs naturally with multi-lot PaymentIntents).
3. **Receipt is a direct best-effort send, not queued.** It uses the same SES transport as other emails but is not yet in the retrying `notifications_queue`. A transient SES failure logs and drops (the payment is unaffected). Future hardening: move into the retry queue.
4. **Thumbnail formats.** PDFKit embeds JPEG/PNG only. SVG/data-URI/WebP/GIF (e.g. the demo past-auction tile images) fall back to a "No image" placeholder by design. Real lot photos (Cloudinary JPEG/PNG) embed correctly, as validated.
5. **Cloudinary archival is best-effort.** If a future env lacks Cloudinary creds, PDFs still render/stream/attach; only durable archival + signed-URL retrieval are skipped (the SHA-256 is still recorded).
6. **Two receipts during validation** are an artifact of the test (async hook + explicit capture call); normal operation sends exactly one.
7. **Validation fixture rows** (`7c000000-…` buyer/auction/lot + `AAC-000009`) remain on the staging DB; harmless and idempotently overwritten on re-run. They are clearly labeled "Phase 2 Validation".

---

## 5. What this unlocks (next phases)
- **Sales tax:** `sales_tax_cents` column + summary line already present; wire Stripe Tax (per `tax-architecture-plan.md`) to populate it.
- **Buyer premium:** `buyer_premium_cents` column + summary line present; activation populates it from `billingTermsService`.
- **Seller settlements:** reuse `documentService` (render + brand header + private store + signed URL) and `generated_documents` (`doc_type='seller_settlement'`) — no new infrastructure.
- **Accounting:** `generated_documents` + invoice breakdown columns give a per-document audit trail to aggregate.

**No production deployment performed. Stopping after staging validation, awaiting review.**

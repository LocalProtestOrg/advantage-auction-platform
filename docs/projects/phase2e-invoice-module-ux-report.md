# Phase 2E — Auction Invoices: First-Class Admin Module (Operator UX) — Staging Report

**Status:** Implemented and validated on **staging only**. No production deployment. **Operator-UX reorganization only** — no invoice, payment, reconciliation, Stripe, PDF, email, audit, invoice-numbering, or database-schema logic was changed.
**Date:** 2026-06-24
**Branch:** `feat/phase2-invoice-system` (commit on top of 2A–2D).
**Staging:** `advantage-staging` (`https://advantage-staging-production.up.railway.app`), deployed via `railway up`.

## Objective
Promote invoices from a hidden panel inside Moderation to a **first-class admin module**. New path: **Admin home → Auction Invoices** (instead of Admin → Moderation → Auctions → card → Invoices). Moderation keeps its per-auction Invoices panel as a shortcut and stays focused on auction management.

## What changed (UX + one read-only endpoint)
- **NEW read-only endpoint** `GET /api/admin/invoices/:invoiceId/detail` (admin-only) — aggregates the invoice + buyer + auction + lot + payment, its `generated_documents`, and its audit timeline (invoice/receipt email events + the linked payment's events). **Pure SELECTs over existing tables; mutates nothing; no schema change.** This is the only backend addition; it adds read access, it does not alter any protected logic.
- **NEW page `/admin/invoices.html`** — dedicated invoice operations: auction selector, **search by buyer**, **search by invoice #**, status filters (All / Unpaid / Paid / Refunded[future, disabled]), summary totals (counts + hammer/paid/unpaid amounts), and an invoice table (Invoice # · Buyer · Auction · Lot · Total · Status · Invoice date · Payment date · Actions). Row actions: **View / Download PDF / Resend invoice / Resend receipt (paid only)**. Per-auction toolbar: **Download pickup packet / Reconcile (+ Run safe repair) / Issue missing invoices**. All reuse existing endpoints (`GET …/invoices`, `/pickup-packet`, `/invoice-reconciliation[/repair]`, `/issue-invoices`, `/resend-*`, `/api/invoices/:id/pdf`).
- **NEW page `/admin/invoice-detail.html?id=`** — the permanent invoice record: status, buyer (name/email/phone), auction, winning lot, **financial summary** (hammer/buyer premium/sales tax/shipping/total), **payment** (Stripe Payment Intent/charge ID, payment date, status), **generated documents** (with current-PDF download + archived records), **email history** (from Phase 2D `audit_log`: invoice/receipt sent/skipped/failed + message IDs), and an **audit timeline** (synthesized "Invoice created"/"PDF generated" + real `audit_log` events, time-ordered).
- **Navigation:** admin home **"Auction Invoices"** card → `/admin/invoices.html`. Moderation per-auction Invoices panel unchanged (shortcut).

## Validation (deployed staging) — PASS
| Check | Result |
|---|---|
| `GET /api/admin/invoices/:id/detail` — admin | **200**, sections: invoice, buyer, auction, lot, payment, documents, audit ✓ |
| Detail endpoint — buyer | **403** ✓ |
| Detail endpoint — no token | **401** ✓ |
| `/admin/invoices.html` served | **200** (renders management UI) ✓ |
| `/admin/invoice-detail.html` served | **200** (renders details UI) ✓ |
| **No regression** — existing `GET /api/admin/auctions/:id/invoices` | **200**, totals unchanged (`hammer 22500 / paid 14500 / unpaid 8000`) ✓ |
| Admin home card → new page | href `/admin/invoices.html` ✓ |
| Moderation per-auction Invoices panel | unchanged, still functions (markers present) ✓ |

**No-regression notes:** invoice generation, payment flow, reconciliation, repair, PDF, email, audit logging, and invoice numbering are byte-for-byte unchanged (no edits to those services). The only backend change is an additive read-only GET endpoint. Existing endpoints continue to return their prior shapes (the `totals` field on `GET …/invoices` was added in Phase 2D, not here).

## Existing functionality — all still accessible (Part 4)
Download Invoice PDF ✓ · Download Pickup Packet ✓ · Reconcile ✓ · Run Safe Repair ✓ · Issue Missing Invoices ✓ · Resend Invoice ✓ · Resend Receipt ✓ — now surfaced cohesively on the Auction Invoices page (and still in Moderation's panel).

## Production readiness
This phase adds **no migration** and changes no protected logic, so it folds into the existing Phase 2 production-readiness checklist (`phase2d-invoice-readiness-report.md`) unchanged — apply migrations 072+073 (with the duplicate-invoice preflight), backup, deploy, and run admin/buyer UAT (now starting from the **Auction Invoices** home card). The new pages + read-only endpoint deploy with the same build.

## Open items
- Carried from earlier phases: email queue migration (reliability), periodic reconciliation sweep, consolidated per-buyer invoice. None are blockers.
- "Refunded" filter is present but inert until refund-state invoices exist (future).

**No production deployment. Stopping after deployed staging validation, awaiting approval to promote.**

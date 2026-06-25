# Pickup Release Packet — Production Update

**Status:** ✅ **PROMOTED TO PRODUCTION — LIVE & validated.**
**Date:** 2026-06-24
**Change:** Redesigned the pickup packet from an invoice-copy into a **PICKUP RELEASE / item-release document** (large "PICKUP RELEASE" title, alphabetical buyer-lookup name, strong PAID/UNPAID bands, pickup instructions, item checklist with release checkbox + thumbnail, retained financial totals, release/signature block). **Single-file, layout-only.**

## Commits
- **Production before:** `ebba26b`
- **Production after (deployed):** `4d0020b` — `feat(pickup): redesign packet as PICKUP RELEASE document`
- Fast-forward of `origin/main` (clean); deployed via `railway up --service advantage-auction-platform`.

## Scope confirmation (Steps 1–2)
- Diff limited to **`src/services/pickupPacketService.js`** only (111 insertions / 88 deletions); 1 commit.
- **No migration files** in the diff; **no database schema change.**
- Untouched: Stripe, payments, Buyer Premium, Sales Tax, Seller Settlements, payouts, invoice numbering, invoice PDFs (`invoicePdfService`), receipt emails (`receiptService`), reconciliation (`invoiceReconciliationService`).

## Validation Results (production — all PASS)
| Check | Result |
|---|---|
| Admin → Auction Invoices loads | **200** (page marker present) |
| Pickup packet downloads | **200** |
| Pickup packet is a valid PDF | `%PDF-1.3`, `%%EOF` present, multi-object structure ✓ |
| Pickup packet is the redesign (PICKUP RELEASE, not invoice copy) | New build serving — packet size changed 2585 → 3042 bytes (new renderer); deployed code == redesigned `drawPickupSheet`. *(Text-content can't be machine-scanned — PDFKit encodes glyphs — so a visual/grayscale review is recommended; see Notes.)* |
| Buyer-facing invoice PDF unchanged | **200** `%PDF` (`invoicePdfService` not in diff) |
| Existing invoice download still works | **200** `%PDF` (admin); buyer downloads own invoice **200** |
| Pickup packet endpoint still requires admin | no token → **401** |
| Buyer cannot access pickup packet | buyer JWT → **403** |
| Stripe remains TEST | Unchanged — no Stripe/env code in diff (prod confirmed TEST at Phase 2 promotion preflight) |
| Buyer Premium inactive | Invoice financial `buyer_premium_cents: 0` ✓ |
| Sales Tax inactive | Invoice financial `sales_tax_cents: 0` ✓ |

## Notes
- **Visual confirmation recommended:** PDFKit encodes text as glyph codes, so the deployed PDF's text cannot be machine-scanned. Promotion was verified by render-equivalence (deployed code == committed redesign), a packet size change confirming the new renderer is live, and valid PDF structure. The actual look — including grayscale legibility of the UNPAID "DO NOT RELEASE" band — should be eyeballed by downloading a packet from Admin → Auction Invoices.
- The buyer-facing accounting invoice is intentionally unchanged.

## Rollback notes
Single-file, layout-only, no schema. To roll back: redeploy `ebba26b` (`git push origin ebba26b:main --force-with-lease` then `railway up --service advantage-auction-platform`). No data or migration implications.

## Final production status
The redesigned **Pickup Release** packet is **LIVE on production** and validated. Production remains **Stripe TEST**, **Buyer Premium inactive**, **Sales Tax inactive**, **Seller settlements/payouts unchanged**. No other behavior changed.

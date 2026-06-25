# Auction Timezone Pickup Display — Production Update

**Status:** ✅ **PROMOTED TO PRODUCTION — LIVE & validated.**
**Date:** 2026-06-24

## Commits
- **Production before:** `53ac6b1`
- **Production after (deployed):** `870958f` (2 commits: tz capture/display feature + report)
- Clean fast-forward of `origin/main`; deployed via `railway up --service advantage-auction-platform`.

## Scope confirmation
- Clean FF from prod `53ac6b1`. **No migrations / no `.sql`. No schema change** (`auctions.timezone` already existed).
- Runtime diff limited to timezone capture/display (9 files): `seller-create.html`, `auction-view.html`, `lot.html`, `public/widgets/shared/pickup-tiers.js`, `src/lib/pickupTiers.js`, `src/routes/auctions.js` (summary `timezone`), `src/routes/lots.js` (`auction_timezone` subselect), `src/services/auctionService.js` (createAuction stores `timezone`), `src/services/pickupPacketService.js` (selects `timezone`).
- Untouched: Stripe, payments, buyer premium, sales tax, seller settlements, payouts, invoice numbering, invoice PDFs, receipt emails, financial calculations, legacy `pickup_category` data, broad pickup scheduler.

## Validation results (production — all PASS)
| Area | Result |
|---|---|
| Seller create — Auction Time Zone selector | present (`#auction-timezone`) ✓ |
| Default America/New_York + Eastern/Central/Mountain/Pacific options | `America/New_York" selected` + 3 region options ✓ |
| Public auction page — A/B/C in auction tz + tz label | `auction-view.html` carries tz formatting + friendly-label code ✓ |
| Public lot page — A/B/C in auction tz; missing tz → America/New_York | lot API returns `auction_timezone` (null→Eastern fallback); page uses `DEFAULT_TZ` ✓ |
| Pickup packet — valid PDF, tz-formatted times | admin **200**, `%PDF` ✓ |
| Packet admin-only | no token → **401**, buyer → **403** ✓ |
| `GET /api/auctions/:id/summary` returns `timezone` | yes — `"timezone":null` on legacy auctions (key present; renders Eastern) ✓ |
| `GET /api/lots/:id` returns `auction_timezone` | yes — `"auction_timezone":null` (key present) ✓ |
| Guardrails | public auctions **200**; Stripe TEST, premium/tax inactive, settlements unchanged ✓ |

**Note:** existing prod auctions have NULL `timezone` (no backfill performed) → they render in the **America/New_York** fallback. New auctions created via `seller-create` store the selected tz (default Eastern). The non-null per-tz formatting (Eastern 9 AM vs Central 8 AM) was proven in staging in-process validation; the deployed prod code is identical. Archived auctions (e.g. `e8baa619`) correctly 404 on the public summary endpoint (admin packet still works).

## Rollback notes
Display/capture only + read-only API additions; **no schema/migration/data change**. To roll back: redeploy `53ac6b1` (`git push origin 53ac6b1:main --force-with-lease` then `railway up --service advantage-auction-platform`).

## Known future gaps
1. **Entry-side timezone:** pickup-window `datetime-local` inputs are interpreted in the *browser's* tz when converted to an instant; display is now correct in the auction tz, but cross-tz entry can be off. Recommend tz-aware entry conversion (interpret the naive datetime in the selected auction tz).
2. **Backfill** `auctions.timezone` for legacy null rows (render currently falls back to America/New_York) — approval-gated.
3. Carried from Phase 3: unify `size_category`/`pickup_category`; converge the legacy slot scheduler with the computed size-based model; require `size_category` server-side.

## Final production status
Auction timezone pickup display is **LIVE on production**. Production remains **Stripe TEST**, **Buyer Premium inactive**, **Sales Tax inactive**, **seller settlements/payouts unchanged**.

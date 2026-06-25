# Pickup Scheduling Phase 3 — Production Update

**Status:** ✅ **PROMOTED TO PRODUCTION — LIVE & validated.**
**Date:** 2026-06-24

## Commits
- **Production before:** `f15713e`
- **Production after (deployed):** `a9938fe` (3 commits: Phase 3 feature + UTC clock fix + report)
- Clean fast-forward of `origin/main`; deployed via `railway up --service advantage-auction-platform`.

## Scope confirmation
- Clean FF from prod `f15713e`. **No migrations / no `.sql` in the diff. No schema change. No legacy `pickup_category` data touched.**
- Runtime diff limited to Phase 3 (7 files): `public/auction-view.html`, `public/lot.html`, `public/lot-builder.html`, `public/widgets/shared/pickup-tiers.js` (new), `src/lib/pickupTiers.js` (new), `src/routes/lots.js` (read-only auction-window subselect on `GET /:lotId`), `src/services/pickupPacketService.js`.
- Untouched: Stripe, payments, buyer premium, sales tax, seller settlements, payouts, invoice numbering, invoice PDFs, receipt emails, financial calculations.

## Validation results (production — all PASS)
| Area | Result |
|---|---|
| Lot API per size | `…015`→`A`, `…012`→`B`, `…011`→`C`, each with `auction_pickup_window_start` ✓ |
| Public lot page carries Phase 3 code | `lot.html` includes `pickup-tiers.js` + pickup-time element ✓ |
| Public auction page disclosure | `auction-view.html` includes the "assigned according to the largest item" disclosure + computed Pickup Time rows ✓ |
| Pickup packet — admin | **200**, valid `%PDF`, 5 sheets (Assigned Pickup Time + per-lot times rendered) ✓ |
| Pickup packet — no token / buyer | **401** / **403** (admin-only enforced; buyer cannot access) ✓ |
| Lot Studio button | `lot-builder.html` includes `btn-packing-note` + the exact note text ✓ |
| Invoice PDF still works | admin **200** `%PDF` ✓ |
| Existing public/bidding pages load | `GET /api/public/auctions` **200** ✓ |
| Stripe TEST / Premium / Sales Tax | unchanged; invoice `buyer_premium_cents:0, sales_tax_cents:0` ✓ |

**Note (honest):** the public-page A/B/C rendering and the Lot Studio button are client-side; verified by (a) the lot API returning the correct `size_category` + window per lot (the page computes deterministically from these), (b) the deployed pages carrying the new code + exact text, and (c) the packet (server PDF) rendering valid with the new content. A quick visual eyeball is still recommended (registered-buyer pickup tab; A/B/C lot pages; Lot Studio button appends once / never duplicates / never overwrites).

## Rollback notes
Single-phase, display/computed + one read-only API subselect, **no schema/migration**. To roll back: redeploy `f15713e` (`git push origin f15713e:main --force-with-lease` then `railway up --service advantage-auction-platform`). No data implications.

## Known future gaps (not in scope; recommended next)
1. **Two overlapping A/B/C fields:** Phase 3 (display) uses clean `size_category`; the legacy payment-time slot scheduler uses dirty `pickup_category` (`large`/`medium`/`small`/`M`/`S`, no CHECK). They can disagree. Recommend enforcing a CHECK + cleaning `pickup_category`, then **unifying on one field**.
2. **`size_category` not server-enforced** (`lotValidation` is a stub) → "Not specified" appears for unset lots. Recommend requiring it on lot submission.
3. **`auctions.timezone` essentially unpopulated** → pickup clock times are formatted in **UTC** for deterministic display. Recommend capturing/populating auction timezone and formatting in it.
4. **Two pickup-time notions** (new computed size-based "Assigned Pickup Time" vs legacy payment-time slot assignment) should converge — ideally generate slot assignments from `size_category` at close.
5. **Step 8 handling flags** (Oversized, Forklift, Two-Person Lift, Fragile, Glass/Mirror, Bring Blankets/Tie-Downs/Appliance Dolly): research-only; recommended as **future Lot Studio boolean flags** after the field consolidation above.

## Final production status
Phase 3 Pickup Scheduling & Release is **LIVE on production**. Production remains **Stripe TEST**, **Buyer Premium inactive**, **Sales Tax inactive**, **seller settlements/payouts unchanged**. **Phase 4 / seller settlements not started.**

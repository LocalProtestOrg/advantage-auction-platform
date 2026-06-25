# Timezone-Aware Auction/Pickup Entry — Production Update

**Status:** ✅ **PROMOTED TO PRODUCTION — LIVE & validated.**
**Date:** 2026-06-24

## Commits
- **Production before:** `cdf6c83`
- **Production after (deployed):** `79bf65a` (2 commits: tz-aware entry feature + report)
- Clean fast-forward of `origin/main`; deployed via `railway up --service advantage-auction-platform`.

## Scope confirmation
- Clean FF from prod `cdf6c83`. **No migrations / no `.sql`. No schema change.**
- Runtime diff limited to timezone-aware entry/display (4 files): `public/widgets/shared/timezone-utils.js` (new), `src/lib/timezoneUtils.js` (new), `public/seller-create.html`, `public/admin/moderation.html`.
- Untouched: Stripe, payments, buyer premium, sales tax, seller settlements, payouts, invoice numbering, invoice PDFs, receipt emails, financial calculations, legacy `pickup_category`, broad pickup scheduler. **No dependency added** (native `Intl`).

## Validation results (production — all PASS)
| Area | Result |
|---|---|
| `timezone-utils.js` served (has `localToUtcIso`/`window.TimezoneUtils`) | ✓ |
| Auction Time Zone selector + America/New_York default (seller-create) | ✓ (selector + `America/New_York" selected`) |
| seller-create uses selected-tz conversion | ✓ (`localToUtcIso` + `timezone-utils.js` script) |
| admin moderation renders + saves in auction tz | ✓ (`timezone-utils.js` script + `localToUtcIso`) |
| NY/Central/Mountain/Pacific 9 AM → correct UTC (prod runtime) | NY **13:00Z**, CT **14:00Z**, MT **15:00Z**, PT **16:00Z** ✓ |
| DST case | January NY → **14:00Z** (EST) ✓ |
| Public auction page / lot page load | public auctions **200**, summary **200**, lot.html **200**, lot API **200** ✓ |
| Pickup packet downloads valid PDF | admin **200** `%PDF`; no-token **401**; buyer **403** ✓ |
| Invoice PDF downloads valid PDF | admin **200** `%PDF` ✓ |
| Guardrails | Stripe TEST, premium/tax inactive, settlements/payouts unchanged (no such code touched) ✓ |

## Rollback notes
Client-side form-handling + two new helper files; **no schema/migration/data change, no server logic change** (the server still stores whatever ISO instant it receives). To roll back: redeploy `cdf6c83` (`git push origin cdf6c83:main --force-with-lease` then `railway up --service advantage-auction-platform`). No data implications; auctions created during the window keep their (correctly converted) stored instants.

## Known future gaps
1. **Existing auctions** keep instants entered under the old browser-tz logic (not retroactively corrected); display falls back to America/New_York for null timezone. Backfill/normalization is a separate, approval-gated step.
2. Admin "change timezone mid-edit" reinterprets the shown wall-clock in the newly-selected tz on save (intended) — re-verify times if only relabeling the tz.
3. Carried items: unify `size_category`/`pickup_category`; converge the legacy slot scheduler with the computed model; require `size_category` server-side.

## Final production status
Timezone-aware auction/pickup datetime entry is **LIVE on production**. Production remains **Stripe TEST**, **Buyer Premium inactive**, **Sales Tax inactive**, **seller settlements/payouts unchanged**.

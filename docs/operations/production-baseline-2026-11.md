# Production baseline 2026-11 (checkpoint)

Deployed 2026-11-09 00:12 UTC with the owner's explicit GO. Verified the same evening (read-only checks and live HTTP).

## Code and data

| Item | Value |
|---|---|
| Production commit | `3b3ac8a` (main), git tag `baseline-2026-11` |
| GitHub CI on that commit | run 42537016287: passed (348 suites / 6,952 tests; browser 14 suites / 123 tests) |
| Migrations | through 226: 221 (welcome emails), **222** (platform owner, setting audit), **223** (paid authorizations), **226** (removed 4 unused fee settings). 218 to 220 (PR #86) NOT applied |
| Pre-deploy backup | Neon `prod-pre-baseline-2026-11` (`br-small-bonus-anad0fxu`), counts verified identical to production before any change |
| Baseline snapshot | Neon `baseline-2026-11` (`br-fragrant-pond-anmhcdo1`), taken after deployment |
| Record counts (unchanged by the deployment) | users 107, sellers 33, auctions 74, lots 2,373, bids 393, payments 35, invoices 86, storefront items 13, storefront orders 0, agreements 17, signatures 13, terms acceptances 46, seller payouts 46 |

## Agreements and terms

- Seller Agreement: **version 4** current (published 2026-11-06; 5% / 9% storefront). Sellers who signed earlier versions,
  and the 10 launch-time waived sellers, accept v4 at their next new listing; nothing is sent to them. No v4 agreement
  has been issued yet. Agreement display and PDF render without markdown marks.
- Buyer terms: **version 3** current (unchanged). Full Terms of Service v4 prepared, **not published**; owner decisions
  pending (`docs/legal/buyer-terms-v4-substantive-review.md`). New accounts must tick the terms box.

## Pricing (unchanged calculations)

- Individual Sellers: 18% buyer's premium (fixed), no platform fee, 3% processing.
- Professional Seller auctions: **7% total** = 4% platform fee + 3% payment processing (negotiated agreements apply).
- Professional Storefront: 5% (seller's own site) / 9% (marketplace), all-in; online checkout not open.

## Ownership and notices

- Platform owner: **tylerwitt2015@gmail.com** (only owner). admin@advantage.bid: ordinary administrator.
- Owner notices: email to tylerwitt2015@gmail.com and advantageauction.bid@gmail.com; text to the owner-alert numbers
  (ending 3461 and 0770). Verified: the emergency-stop notice reached 2 of 2 emails and 2 of 2 texts.
- Business and commercial-email address: Advantage.Bid, 2205 Ogden Hwy, Adrian, MI 49221.

## Switches

| Switch | State |
|---|---|
| Advertising emergency stop (`marketing.paid.global_kill`) | **ON** (engaged at deploy; clearing is the owner's decision). No authorization exists |
| Storefront checkout (`MARKETPLACE_CHECKOUT_ENABLED`) | off |
| Sell Online page | off (404) |
| Marketing packages and promotions | all 7 not purchasable (benefits not deliverable yet) |
| Seller activation (R-1) | Individual track live (as before); **Professional track record-only** (`pro_mode` unset) |
| Claimed-listing sending, Event Partner outreach | off |
| Buyer verified-email requirement | off |
| Seller payouts | direct deposit (ACH) only for sellers; auction payouts via Stripe Connect as before |

## Outstanding work

- Owner decisions on Buyer Terms v4 provisions (governing law and courts, waivers, indemnity, liability cap, chargeback
  costs, Schedule A fees; align the $50/day missed-pickup storage default).
- Counsel: Seller Agreement 11.2 liability cap; items in `docs/legal/pre-counsel-publication-record.md`.
- Before ads resume: zero-spend Meta verification (`docs/operations/paid-ads-resume-runbook.md`); the emergency stop's
  Meta step was tested only against simulated responses.
- Packages stay blocked until owned placements are shown publicly.
- Two automated setting writes (`paidCostIngestionService`, `bidder_phone.required_since`) are not yet in the setting audit.
- The admin Marketing Agency browser test is opt-in (test-database limitation, reproduced on main).
- Next initiative: the autonomous Professional Seller growth engine.

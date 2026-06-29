# Historical Auction Archive — Phase 1c Presentation Polish Validation

**Status:** ✅ Implemented and validated on **staging only**. Not committed to git; **not promoted to production**.
**Staging URL:** https://advantage-staging-production.up.railway.app
**Builds on:** `phase-1-staging-validation-report.md` + `phase-1b-ux-refinement-validation.md`. No DB migration. Stripe stays TEST; no payment/fee/settlement logic touched.

---

## Changes by request item

| # | Request | What changed |
|---|---|---|
| 1 | Remove duplicate lot title | `lot.html`: the title renders **once** as the primary heading. Category + "Lot N" moved into a subhead directly beneath it; the left-column category copy and the item-details "Lot" entry are suppressed for historical lots (no repetition). |
| 2 | Conservative title cleanup | New `cleanTitle()` in the importer: removes stray asterisks, collapses whitespace, fixes spacing around punctuation, strips leading artifact symbols, capitalizes the first letter. **Deliberately does NOT** title-case words (would corrupt units like "CT"/"MM" and proper nouns), insert separators, or un-truncate (no invented/inferred content). 19 titles cleaned; carat decimals (e.g. ".65 CT") preserved exactly. |
| 3 | Display the auction name | `lot.html` header shows the actual historical auction title (e.g. "Fine Crystal and Gem Auction $5 Start Price") instead of "Advantage Auction". (`/api/lots/:id` now returns `auction_title`.) |
| 4 | Improve the Back button | For historical lots, Back navigates **directly** to that auction's page (`/auction-view.html?auctionId=…`) rather than relying on browser history. |
| 5 | Refine status panel hierarchy | **SOLD** is now the large primary element (2.4rem); "Historical Auction Archive" is a small secondary label beneath it. |
| 6 | Improve archive wording | Now reads: *"This item was previously offered by Advantage Auction Company and is preserved as part of our Historical Auction Archive."* + retained *"This auction has ended and is presented for historical reference only."* |
| 7 | Related-action footer | Bottom of each historical lot page: **"Interested in similar items? Browse current Advantage.Bid auctions →"** linking to `/`. |
| 8 | Auction context section | A block showing **Auction / <auction name> / N Lots**, linking back to the auction. (`/api/lots/:id` now returns `auction_lot_count`.) |
| 9 | Page titles / metadata | Historical lot and auction pages use **"… — Advantage Auction Company Historical Archive"** browser titles; Past Auctions page metadata already updated in 1b. |

---

## Final QA (live on staging)

| Check | Result |
|---|---|
| Review multiple auctions | ✅ all 8 verified in the closed list with covers |
| Review lots from different auctions | ✅ spot-checked lots in auctions 1–8: clean titles, correct auction context + lot counts, categories, null prices |
| Images load where available | ✅ covers/lot images HTTP 200 `image/jpeg` |
| Navigation / Back button | ✅ Back goes straight to the source auction for historical lots; context + footer links resolve |
| Auction context section | ✅ `auction_title` + `auction_lot_count` returned and rendered (e.g. "Fine Crystal and Gem Auction $5 Start Price · 231 Lots") |
| No duplicate titles | ✅ single `lot-title` heading; category/Lot only in the subhead |
| No bidding UI | ✅ archive status panel replaces all bid/registration/Stripe elements |
| No prices | ✅ all price fields NULL; `priced=0`; suppressed on every surface |
| No historical dates public | ✅ only internal placeholders (2026-05-25…06-01) exist; never rendered |
| No LiveAuctioneers branding/metadata | ✅ **0** "liveauctioneers" references in served `index/past-auctions/auction-view/lot/search`; DB: 0 LA in titles, 0 LA image URLs, 0 stray asterisks, 0 non-Cloudinary images, 0 non-null descriptions |
| Data integrity | ✅ 8 auctions, 1802 lots, 1755 imaged, 47 imageless (graceful "Historical image unavailable."), 11 categories, leakage all 0 |

---

## Notes for review

- **Title cleanup is intentionally conservative.** Some source titles still contain decade-old OCR artifacts that cannot be fixed without inventing content (e.g. a doubled word like "necklaceklace", or mid-word truncations). These were left as the historical record per "do not infer / do not change historical information." If you want more aggressive normalization (e.g. title-casing the descriptive portion), that can be added — with explicit unit-protection rules — on request.
- **The 4 Phase-2 test auctions** remain archived (`is_archived=true`, reversible) from 1b; only the 8 historical auctions are public.
- **Not committed, not on production.** Code deployed to `advantage-staging` via `railway up`. Production promotion still requires a prod-guarded importer variant + backup/checklist and remains out of scope until approved.

Reproduce: `node scripts/download-historical-images.js` → `railway run --service advantage-staging node scripts/seed-historical-auctions.js --remove-demos`.

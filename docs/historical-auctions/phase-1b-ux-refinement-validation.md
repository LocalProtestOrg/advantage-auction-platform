# Historical Auction Archive — Phase 1b UX Refinement Validation

**Status:** ✅ Implemented and validated on **staging only**. Not committed to git; **not promoted to production**.
**Staging URL:** https://advantage-staging-production.up.railway.app
**Builds on:** `phase-1-staging-validation-report.md`. No DB migration. No payment/fee/settlement logic touched; Stripe stays TEST.

This pass addressed the 11 refinement points so the archive reads as a genuine historical reference with no bidding, pricing, or sample language.

---

## Changes by request item

| # | Request | What changed |
|---|---|---|
| 1 | Past Auctions page copy | `past-auctions.html`: title/H1 → "Historical Auction Archive"; intro + note replaced with the historical-reference copy ("…actual past sales…presented as a historical reference…"). No "sample" language remains. |
| 2 | Remove the 4 remaining demo auctions | The 4 non-historical closed auctions (Phase 2/2B/2C/2D test auctions, `7c/7d/7e/7f…`) were **archived** (`is_archived=true` — reversible, no deletion). Public Past Auctions now shows **only the 8 historical**. |
| 3 | Historical lot detail — no bidding UI | `lot.html`: for historical lots the entire bid panel (current bid, "Be the first to bid", bid form, "Create Free Account" / "Sign in", "Pay only when you win", "Anti-sniping protection", "Secure via Stripe", bid history) is hidden and replaced by an archive status block: **"Historical Auction Archive" / "SOLD"** + "This item is part of the Advantage Auction Company Historical Auction Archive." + "This auction has ended and is presented for historical reference only." No price, no starting bid, no prompts. |
| 4 | Remove pickup info | `lot.html`: the "Pickup Time: Not specified" line is hidden entirely for historical lots. |
| 5 | Image presentation | `lot.html`: removed the "Image N" alt placeholder (alt = lot title); broken images are hidden (no broken-image icon); missing image shows **"Historical image unavailable."** |
| 6 | Lot title formatting | `lot.html`: title shows the name only (e.g. "Czech Cut Crystal Bowl"); the original number moves to the metadata section as **"Lot 15"**. |
| 7 | Standardize labeling | One label everywhere: **"Historical Auction Archive"** (past-auctions cards, homepage results, auction detail badge). |
| 8 | Historical auction cards | Cards show only: title, "Historical Auction Archive" label, lot count, "View Lots". No bid counts, sale prices, follower counts, subtitle, or sample/demo language. |
| 9 | Historical auction page header | `auction-view.html`: badge "Historical Auction Archive" by the title; subtitle "Presented for historical reference only."; meta shows location only (no date, no "sale results"); seller follow bar + follower count hidden. |
| 10 | Realized prices never shown | No realized prices are imported (all NULL) **and** every surface (lot page, auction grid, search) suppresses price for historical — for anonymous and signed-in users alike. |

---

## Final validation (live on staging)

| Check | Result |
|---|---|
| [1] All 8 historical auctions display | ✅ closed list returns 8, each with a Cloudinary cover |
| [2] Historical lot pages display | ✅ `auction_public_type=historical_archive`; archive status panel served |
| [3] Images load where available | ✅ lot image + covers return HTTP 200 `image/jpeg` |
| [4] Missing images fail gracefully | ✅ imageless lot `/images` → `{data:[]}`; UI shows "Historical image unavailable." (no broken placeholder) |
| [5] No remaining sample/demo auctions | ✅ closed list = 8 historical, 0 non-historical |
| [6] No bidding language in historical | ✅ `lot.html` hides all bid/registration/Stripe UI; archive panel only |
| [7] No realized prices | ✅ all price fields NULL; `priced=0`; UI suppressed everywhere |
| [8] No original dates shown | ✅ no dates rendered for historical; API exposes only the internal placeholder (never the real date) |
| Data integrity | ✅ 1802 lots, 47 imageless, leakage: priced=0, descriptions=0, bids=0; all subtitles = "Presented for historical reference only." |
| "Sample" language anywhere | ✅ 0 occurrences in served `past-auctions.html` / `index.html` (fallback strings neutralized to "Past Auction") |

---

## Notes for review

- **The 4 archived test auctions** are hidden, not deleted — set `is_archived=false` to restore any if needed.
- **Realized-price safety** is currently guaranteed by (a) no price data imported and (b) per-surface UI suppression. The shared server-side `redactRealizedPrice` was intentionally left unchanged (it only affects lots that *have* a price; historical lots have none).
- **Not committed, not on production.** Code deployed to `advantage-staging` via `railway up`. Production promotion still requires a prod-guarded importer variant + backup/checklist and remains out of scope until approved.

Reproduce: `node scripts/download-historical-images.js` → `railway run --service advantage-staging node scripts/seed-historical-auctions.js --remove-demos`.

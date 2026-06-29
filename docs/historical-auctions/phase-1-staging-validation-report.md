# Historical Auction Archive — Phase 1 Staging Validation Report

**Status:** ✅ Implemented and validated on **staging only**. Not committed to git; **not promoted to production** (awaiting review).
**Staging URL:** https://advantage-staging-production.up.railway.app
**Scope:** Import Advantage Auction Company's 8 own historical auction catalogs as native closed (non-archived) auctions, reusing existing platform architecture. No database migration.

---

## 1. What was built (all reuse; no new tables, no migration)

| Artifact | Purpose |
|---|---|
| `scripts/download-historical-images.js` | Local, safe, resumable image retriever. Reads each `image_url_map.csv`, fetches the primary image, saves into the catalog's `images/` folder using the exact archive filename. Rate-limited, 1 retry, per-request timeout; a failed image is skipped (never aborts). `--dry-run` plans without writing. |
| `scripts/seed-historical-auctions.js` | STAGING-guarded importer. Re-hosts local images to Cloudinary and seeds `auctions` / `lots` / `lot_images`. Idempotent (deterministic `5c…` UUIDs + local Cloudinary URL cache). `--remove-demos` replaces the old sample set. |
| `src/routes/auctions.js`, `src/routes/lots.js`, `src/routes/public.js` | Added the already-public-safe `public_auction_type` to the auction-summary, lot-detail, and lot-search responses so the front end can detect historical auctions. Additive SELECT columns only. |
| `public/past-auctions.html`, `public/index.html`, `public/auction-view.html`, `public/lot.html`, `public/search.html` | Historical-aware rendering: subtle "Historical Auction" indicator; **no dates**, **no prices/bids** shown for historical auctions/lots. Non-historical behavior unchanged. |

**Sentinel:** `auctions.public_auction_type = 'historical_archive'` (free-text column that already existed and is already exposed publicly). No schema change.

**Database migration required:** **None.** Every field maps to existing columns.

---

## 2. Import results (staging DB)

```
historical auctions: 8/8   (state=closed, is_archived=false, public_auction_type=historical_archive)
lots:                1802  (matches the archive manifest exactly)
imaged:              1755  Cloudinary-rehosted
imageless:             47  (left without an image, by design)
categories:            11  (preserved verbatim)
seller:              Advantage Auction Company (dedicated profile 5c0000…00aa)
demo auctions:          0  (the 6 "Sample Auction Results" demos removed)
```

**Leakage checks (all 0, as required):** realized prices = 0, winning buyers = 0, descriptions = 0, bids = 0.
**Image integrity:** 1755 `lot_images` rows, 0 non-Cloudinary URLs, 0 stray image rows on imageless lots.

### Per-auction (display order = internal placeholder date, descending; never shown publicly)
| # | Auction | Lots | Imaged | Imageless | Placeholder date (internal) |
|---|---|---|---|---|---|
| 1 | No Reserve Designer Accents, Art & Furniture | 174 | 170 | 4 | 2026-06-01 |
| 2 | Fine Crystal and Gem Auction $5 Start Price | 231 | 228 | 3 | 2026-05-31 |
| 3 | $1 Semi-Precious Gem Online Estate Auction | 425 | 422 | 3 | 2026-05-30 |
| 4 | Fine Art and Collectibles | 174 | 170 | 4 | 2026-05-29 |
| 5 | $5 Start - Fine Art and Furniture Auction | 165 | 162 | 3 | 2026-05-28 |
| 6 | Fine Collectibles Estate Auction | 209 | 204 | 5 | 2026-05-27 |
| 7 | Steiff - Gund, 400+ Ltd. Edition Collectables | 378 | 356 | 22 | 2026-05-26 |
| 8 | No Reserve, No BP, Jewelry Auction | 46 | 43 | 3 | 2026-05-25 |

### Categories (preserved exactly from the archive)
Gemstones (592), Furniture (482), Art & Wall Décor (332), Decorative Objects (128), Crystal & Glass (116), Jewelry (94), Lighting & Decorative Accessories (27), Porcelain & Decorative Ceramics (25), Silver & Tableware (3), Arms & Decorative Weapons (2), Mirrors (1). All 11 already exist in the platform's free-text category model; no remapping was needed.

---

## 3. Live HTTP validation (deployed staging)

- `GET /api/public/auctions?state=closed` → **12 closed**, **8 historical**, **0 demos remaining**; each historical card carries a Cloudinary `cover_image_url` and `public_auction_type=historical_archive`.
- `GET /api/auctions/<id>/summary` → returns `public_auction_type=historical_archive`, `subtitle="Historical Auction"` (confirms the new code is deployed).
- `GET /api/lots/<id>` → cleaned title, real category, our own lot number, `state=closed`; `winning_amount_cents/current_bid_cents/starting_bid_cents = null`, `bid_count=0`, `description=null`, `size_category=null`; Cloudinary thumbnail.
- `GET /api/public/lots/search?status=closed` → historical lots return `auction_public_type` with null prices (UI shows "Historical archive", not "$1.00").
- Cover images spot-checked across auctions 2/5/7 → **HTTP 200, image/jpeg**.
- `past-auctions.html` → **HTTP 200**.

### Date & price suppression (front-end)
- Past Auctions cards: "Historical Auction" badge, **no "Closed <date>"**, lots count only (no bids); page note reworded to a historical-archive message.
- Homepage Recent Auction Results: "Historical" badge, **no date** (shows "Advantage Auction Company"), lots only.
- Auction detail: subtle "Historical Auction" badge by the title; meta reads "Historical auction archive"; lot grid shows **no price line**; lot-count label drops "sale results".
- Single lot page & search: **no price/realized-price prompt** for historical lots.

---

## 4. Image sourcing & licensing

These are **Advantage Auction Company's own** historical catalogs (first-party content), so re-hosting the lot photos is materially different from third-party scraping. Images were downloaded once from the still-valid source URLs and re-hosted on the platform's Cloudinary (`historical-auctions/<n>/<filename>`); the platform serves only its own copies (no hot-linking). The 1,755 retrieved images use the archive's exact filenames; the 47 that could not be retrieved (5 transient fetch failures + 42 with no source URL in the maps) were left without an image, per instruction.

---

## 5. Remaining items / notes for review

1. **47 imageless lots** — present with full title/category/order but no photo. Re-running `download-historical-images.js` (resumable) then the importer can backfill any that become retrievable; otherwise they remain image-free. Manifest: `docs/historical-auctions/archive/import-manifest-images.json`.
2. **Live category browse** (`/api/public/categories`, the homepage dropdown) counts only `published`/`active` lots, so the 11 historical categories do **not** appear there — by design (historical lots are discoverable via Past Auctions, not the live-auction browse). No change made.
3. **API exposes the placeholder `end_time`** (not the original date). The UI never displays it for historical auctions; the value is a recent internal placeholder (2026-05-25…06-01) used only for ordering, so no original auction date is revealed.
4. **Demo seed scripts** (`prod-/stg-seed-past-auctions.js`) are untouched and still present; re-running the staging one would re-create the sample demos. They are now superseded by the historical archive on staging.
5. **Not committed, not on production.** Code is deployed to the `advantage-staging` service via `railway up`; nothing pushed to git or promoted to prod. Stripe remains TEST; no payment/settlement/fee logic touched.

---

## 6. How to reproduce / promote (when approved)

```bash
# 1. Retrieve images locally (resumable, safe)
node scripts/download-historical-images.js

# 2. Re-host to Cloudinary + seed DB (STAGING)
railway run --service advantage-staging node scripts/seed-historical-auctions.js --remove-demos

# Production promotion (ONLY after approval): the importer currently REFUSES the prod
# endpoint by design. Promotion would require a prod-guarded variant + the standard
# backup/checklist, and is intentionally NOT included here.
```
